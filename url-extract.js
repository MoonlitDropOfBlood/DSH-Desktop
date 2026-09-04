"use strict";

/**
 * URL 行提取（dsh-desktop 主进程专用纯函数）
 * ---------------------------------------------
 * 从 DSH 核心 stdout 的一行日志里提取 web 服务地址。
 *
 * 核心 >= 0.1.2-rc.1 打印的 URL 会携带认证 token（query 或 fragment 形式），
 * 例如 `dsh web: http://127.0.0.1:3080/?token=AbC…`。桌面壳必须把【完整】URL
 * 交给窗口加载——若只截取到端口（旧行为 `https?://127\.0\.0\.1:\d+`），token
 * 丢失，页面以未认证状态启动，会一直卡在认证等待界面。
 *
 * 老核心（<= 0.1.1-rc.2）打印裸地址 `http://127.0.0.1:3080`，本提取器同样兼容。
 *
 * 防御性处理：
 *  - 剥离 ANSI 转义序列（终端彩色输出可能包住 URL 行）；
 *  - URL 之后若有行内注释/标点，按空白、引号、尖括号截断，并去掉行尾句点等
 *    常见标点，避免把杂散字符带进 loadURL。
 */

const URL_RE = /https?:\/\/127\.0\.0\.1:\d+(?:[/?#][^\s"'<>]*)?/;

/** 剥离 ANSI CSI 转义序列（\x1b[...m 等）。 */
function stripAnsi(s) {
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** 去掉 URL 行尾可能混入的常见标点。 */
function trimTrailing(s) {
  return s.replace(/[.,;:)\]}>]+$/, "");
}

/**
 * 从一行日志中提取 DSH web URL（含 token）；找不到返回 null。
 * @param {string} line
 * @returns {string | null}
 */
function extractDshUrl(line) {
  if (typeof line !== "string") return null;
  const clean = stripAnsi(line);
  const m = clean.match(URL_RE);
  return m ? trimTrailing(m[0]) : null;
}

module.exports = { extractDshUrl, URL_RE, stripAnsi };
