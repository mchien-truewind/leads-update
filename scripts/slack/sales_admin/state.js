const fs = require('fs');
const path = require('path');

class SalesAdminState {
  constructor(filePath, logger = console) {
    this.filePath = filePath;
    this.logger = logger;
    this.loaded = false;
    this.data = { records: {} };
  }

  load() {
    if (this.loaded) return this.data;
    this.loaded = true;
    if (!this.filePath || !fs.existsSync(this.filePath)) return this.data;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data = parsed && typeof parsed === 'object' && parsed.records
        ? parsed
        : { records: {} };
    } catch (err) {
      this.logger.error(`Sales admin state read failed: ${err.message}`);
      this.data = { records: {} };
    }
    return this.data;
  }

  get(key) {
    return this.load().records[key] || null;
  }

  has(key) {
    return Boolean(this.get(key));
  }

  set(key, value) {
    this.load().records[key] = {
      ...(this.load().records[key] || {}),
      ...(value || {}),
      key,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.load().records[key];
  }

  update(key, updater) {
    const current = this.get(key) || {};
    const next = typeof updater === 'function' ? updater(current) : { ...current, ...(updater || {}) };
    return this.set(key, next);
  }

  save() {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    fs.renameSync(tmp, this.filePath);
  }
}

function createSalesAdminState(filePath, logger = console) {
  return new SalesAdminState(filePath, logger);
}

module.exports = {
  SalesAdminState,
  createSalesAdminState,
};
