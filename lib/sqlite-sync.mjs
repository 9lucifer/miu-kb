import Database from "better-sqlite3";

export class DatabaseSync {
  constructor(path, options = {}) {
    this.db = new Database(path, { readonly: Boolean(options.readOnly) });
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  close() {
    return this.db.close();
  }
}
