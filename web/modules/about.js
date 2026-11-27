/**
 * 关于：产品介绍、支持作者（微信/支付宝）、产品反馈（QQ 群）与简单免责声明。
 */

import { action, api, badge, button, copyText, el, note, toast } from '../ui.js';

const QQ = '1129803707';

function qrBlock({ title, file, caption }) {
  const src = new URL(file, document.baseURI).href;
  return el('figure', { class: 'qr-block' },
    el('div', { class: 'qr-thumb' }, el('img', { src, alt: title, loading: 'lazy' })),
    caption ? el('figcaption', { class: 'qr-cap', text: caption }) : null);
}

export async function render(root) {
  let version = '';
  try {
    const sys = await api('/api/system');
    version = (sys && sys.app && sys.app.version) || '';
  } catch {
    /* 读不到版本不影响展示 */
  }

  const copyBtn = button('复制群号', async () => {
    try {
      await copyText(QQ, copyBtn);
      toast('已复制 QQ 群号：' + QQ, 'ok');
    } catch {
      toast('复制失败，请手动选择群号', 'warn');
    }
  }, { variant: 'ink' });

  root.append(
    el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: 'NAS助手' }),
        el('p', { class: 'card-desc', text: '飞牛 fnOS 上的一套本地运维工具箱：一键体检、系统清理、网络诊断（含带宽测速）、安全防护、服务进程、Docker 治理、硬盘存储、文件管理、应用中心、监控仪表盘与常用小工具。' })),
      el('div', { class: 'about-tags' },
        badge('本地运行', 'ok'),
        badge('数据不上传', 'ok'),
        badge('零第三方依赖', 'ok'),
        badge('MIT 开源', 'accent'),
        version ? badge('v' + version, 'default') : null),
      el('p', { class: 'about-text', text: '所有扫描、计算与清理都在你自己的 NAS 上完成，不经过任何第三方服务器；涉及改动系统的操作（清理、停止容器、结束进程）都会先确认再执行。' })),

    el('section', { class: 'about-pair' },
      el('div', { class: 'card support-card' },
        el('div', { class: 'card-head' },
          el('h3', { text: '请我喝杯 8+1' })),
        el('div', { class: 'qr-row' },
          qrBlock({ title: '微信', file: 'assets/qr/wechat.jpg', caption: '微信' }),
          qrBlock({ title: '支付宝', file: 'assets/qr/alipay.jpg', caption: '支付宝' }))),

      el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h3', { text: '产品反馈' }),
          el('p', { class: 'card-desc', text: '用不了、跑不对、想加功能，直接进群说。' })),
        el('div', { class: 'feedback-row' },
          qrBlock({ title: 'QQ 群', file: 'assets/qr/qq.png' }),
          el('div', { class: 'feedback-meta' },
            el('div', { class: 'feedback-num', text: QQ }),
            copyBtn)))),

    versionCard(),

    note('免责声明：本工具仅提供本地运维辅助，所有操作由你自行发起并承担结果；执行清理、停止服务、结束进程等操作前请确认影响范围，作者不对误操作造成的数据丢失或服务中断负责。第三方应用与镜像的版权归各自作者所有。', 'warn')
  );

  function versionCard() {
    const info = el('div', { class: 'update-info' }, el('span', { class: 'hint', text: '点击「检查更新」从 GitHub 获取最新版本。' }));
    const checkBtn = button('检查更新', () => action(checkBtn, check), { variant: 'ghost' });
    const link = el('a', {
      class: 'link-btn',
      href: 'https://github.com/84387822-a11y/shuaishuai-nas/releases',
      target: '_blank',
      rel: 'noreferrer noopener',
      text: '版本发布与更新日志',
    });

    async function check() {
      info.replaceChildren(el('span', { class: 'hint', text: '正在检查…' }));
      let d;
      try {
        d = await api('/api/update/check?refresh=1');
      } catch (err) {
        info.replaceChildren(note('检查失败：' + (err.message || err), 'error'));
        return;
      }

      if (d.error) {
        info.replaceChildren(
          el('span', { class: 'update-ver', text: 'v' + (d.current || version || '—') }),
          el('span', { class: 'hint', text: d.error + '，可点右侧链接查看发布页。' }));
        return;
      }

      info.replaceChildren(
        el('span', { class: 'update-ver', text: 'v' + d.current }),
        d.hasUpdate ? badge('发现新版本 v' + d.latest, 'warn') : badge('已是最新', 'ok'),
        el('span', { class: 'hint', text: d.hasUpdate ? `最新版本 v${d.latest}，可前往 Releases 下载。` : `当前已是最新版本 ${d.latest || d.current}` }));
    }

    // 进入页面自动检查一次（失败不打扰）
    check();

    return el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: '版本与更新' }),
        el('p', { class: 'card-desc', text: '从 GitHub Releases 获取最新版本；本工具不会自动下载或安装更新。' })),
      el('div', { class: 'set-row' }, info, el('span', { style: { flex: '1' } }), link, checkBtn));
  }
}
