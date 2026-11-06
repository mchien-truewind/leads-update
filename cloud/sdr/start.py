"""Railway-only startup; initialize the new volume, then drop privileges."""
import os
from pathlib import Path
import stat
import socket
import sys


def main():
    if sys.platform != 'linux' or not os.environ.get('RAILWAY_PROJECT_ID') or not os.environ.get('RAILWAY_ENVIRONMENT_ID'):
        raise SystemExit('This start path is for the reviewed Railway deployment only.')
    role = os.environ.get('SDR_ROLE')
    if role not in ('receiver', 'verifier'):
        raise SystemExit('Explicit service role required.')
    uid = 502 if role == 'receiver' else 503
    os.umask(0o077)
    if role == 'receiver' or os.environ.get('LEMLIST_TEST_SCOPE'):
        if os.environ.get('RAILWAY_VOLUME_MOUNT_PATH') != '/data':
            raise SystemExit('Persistent /data volume required.')
        mount = Path('/data')
        if not stat.S_ISDIR(mount.lstat().st_mode):
            raise SystemExit('Invalid volume mount.')
        state = mount/'state'
        state.mkdir(mode=0o700, exist_ok=True)
        info = state.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, uid):
            raise SystemExit('Unexpected volume owner.')
        if os.geteuid() == 0:
            os.chown(state, uid, uid)
            os.chmod(state, 0o700)
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
    if os.getuid() != uid or os.geteuid() != uid:
        raise SystemExit('Unexpected runtime identity.')
    import uvicorn
    config = uvicorn.Config('cloud.sdr.'+role+':from_environment', factory=True, host='::',
                port=int(os.environ.get('PORT','8080')), workers=1, access_log=False, log_level='error',
                limit_concurrency=32, timeout_keep_alive=5, timeout_graceful_shutdown=10)
    # asyncio's default IPv6 listener is IPv6-only. Explicit dual-stack serves
    # Railway's public proxy and private network regardless of address family.
    with socket.create_server(('::', config.port), family=socket.AF_INET6, dualstack_ipv6=True) as listener:
        uvicorn.Server(config).run(sockets=[listener])


if __name__ == '__main__': main()
