"""Durable private-service write claim, independent of the public receiver.

A committed claim is never cleared, including after an uncertain provider result.
Scope or approval changes cannot grant another attempt on the same volume.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import stat
import time

from .completion import validate_approval
from .lemlist_contract import active, validate_scope


class PrivateClaim:
    def __init__(self, directory, scope, *, clock=time.time):
        validate_scope(scope)
        self.scope, self.clock = dict(scope), clock
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('unsafe private state directory')
        self.path = self.directory/'private-completion.sqlite3'
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError('unsafe private claim database')
        finally:
            os.close(fd)
        with self.db() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS write_claim (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1), scope TEXT NOT NULL,
                approval TEXT, claimed_at REAL)''')
            db.execute('BEGIN IMMEDIATE')
            encoded = json.dumps(self.scope, sort_keys=True)
            row = db.execute('SELECT scope FROM write_claim WHERE singleton=1').fetchone()
            if row and row[0] != encoded:
                raise ValueError('private scope replacement requires explicit migration')
            db.execute('INSERT OR IGNORE INTO write_claim(singleton,scope) VALUES(1,?)', (encoded,))
        fd = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=2)
        db.execute('PRAGMA synchronous=FULL')
        try:
            with db:
                yield db
        finally:
            db.close()

    def claim(self, approval):
        validate_approval(approval)
        encoded = json.dumps(approval, sort_keys=True)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT scope,approval,claimed_at FROM write_claim WHERE singleton=1').fetchone()
            if not row or row[0] != json.dumps(self.scope, sort_keys=True):
                raise ValueError('private claim scope mismatch')
            if row[1] is not None or row[2] is not None:
                if row[1] != encoded or row[2] is None:
                    raise ValueError('private claim approval cannot change')
                return False  # Prior attempt: inspection only, even after expiry.
            active(self.scope, self.clock())
            db.execute('UPDATE write_claim SET approval=?,claimed_at=? WHERE singleton=1',
                       (encoded, self.clock()))
        return True  # FULL-synchronous commit completed before provider dispatch.
