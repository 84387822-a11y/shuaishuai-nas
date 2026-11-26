'use strict';

/**
 * 轻量运行日志：把服务进程的请求与错误追加写入数据目录的 server.log。
 *
 * 说明：
 * - fnOS 原生安装时 lifecycle 脚本已把 stdout 重定向到 app.log；
 *   这里再写一份 server.log，方便「关于 → 运行日志」直接查看/下载。
 * - 同步追加即可：本应用是低流量本地工具，不需要复杂日志框架。
 * - 超过 5MB 自动轮转为 server.log.1，避免长期运行把磁盘写满。
 */

const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR } = require('./util');

const LOG_FILE = path.join(DATA_DIR, 'server.log');
const MAX_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size > MAX_BYTES) {
      const backup = `${LOG_FILE}.1`;
      try { fs.unlinkSync(backup); } catch { /* ignore */ }
      fs.renameSync(LOG_FILE, backup);
    }
  } catch {
    /* 文件不存在时无需轮转 */
  }
}

function write(line) {
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* 日志写入失败不影响主流程 */
  }
}

module.exports = { write, LOG_FILE };
