// 页面与下载面板共用语言状态；切换时即时重绘，不重新探测或改变下载目标。
export let locale = /^zh/i.test(globalThis.navigator?.language || 'zh') ? 'zh' : 'en';
const messages = {
  zh: {
    slogan: '文档、编程、手机控制、深度研究，口袋里全部搞定。',
    lede: '在 Android 上运行 DeepSeek Harness，内置完整运行环境，装机即用。',
    repo: '开源仓库', skip: '跳到下载', downloadTitle: '下载 Android 版',
    requirements: 'Android 8.0 及以上 · 内置引擎与 Termux 环境',
    sourceNote: '安装包来自 GitHub Releases，镜像加速源为第三方服务。',
    aboutTitle: '关于 dsh-mobile',
    about: '把 DeepSeek Harness 带到手机上。处理文档、编写代码、操作手机、开展研究，让任务随身继续。',
    abiTitle: '该下载哪个架构',
    abiHelp: '大多数 Android 手机选择 arm64；对应架构的安卓模拟器选择 x86_64。浏览器识别仅供参考，装错架构可能导致引擎无法启动，请使用“更换架构”重新选择。',
    installTitle: '安装说明',
    installHelp: '下载后打开 APK，按系统提示允许浏览器安装应用。与已安装版本签名一致时可覆盖升级并保留数据。首次使用请按应用引导配置模型。',
    slowTitle: '常见问题 · 下载很慢或失败',
    slowHelp: '系统自动在官方源与镜像加速源中选择线路。如下载失败，点击下载按钮下方的“切换”，手动选择另一类来源后重试。检测超时不代表无法下载。',
    safetyTitle: '常见问题 · 安装包安全吗',
    safetyHelp: '本站不托管、不修改安装包。可展开“安装与校验说明”，核对文件名与 SHA-256；发布页的 MANIFEST.txt 提供完整校验清单。',
    history: '全部版本', upstream: '上游项目', privacy: '无 Cookie、无统计脚本。',
    loading: '正在读取版本信息…', download: '下载安装包',
    official: '官方源', mirror: '镜像加速源', auto: '自动选择', switch: '切换',
    source: '下载来源', automatic: '自动路由', manual: '手动选择',
    checking: '正在选择线路', uncertain: '检测未确认，可手动切换',
    phone: '适用于大多数 Android 手机', emulator: '适用于 x86_64 安卓模拟器',
    chooseAbi: '请选择安装设备', changeAbi: '更换架构',
    arm: '手机安装 · arm64', x86: '模拟器安装 · x86_64',
    inferred: '推荐架构', detected: '已识别架构', selected: '所选架构',
    unsupported: '当前设备暂不支持', unsupportedHelp: '目前提供 arm64 和 x86_64 两种 64 位安装包。',
    noAsset: '该版本暂无匹配安装包', error: '版本数据暂不可用，请前往发布页下载。',
    verification: '安装与校验说明', file: '文件名',
    missingHash: '该版本未提供内联校验值，请在发布页的 MANIFEST.txt 中核对。',
    copy: '复制 SHA-256', copied: '已复制', copyFailed: '复制失败，请选中校验值复制',
  },
  en: {
    slogan: 'Documents, coding, phone control, deep research. All in your pocket.',
    lede: 'Run DeepSeek Harness on Android, with a complete runtime built in. Install and get started.',
    repo: 'Source code', skip: 'Skip to download', downloadTitle: 'Download for Android',
    requirements: 'Android 8.0 or later · Engine and Termux included',
    sourceNote: 'Packages are hosted on GitHub Releases. Accelerated mirrors are third-party services.',
    aboutTitle: 'About dsh-mobile',
    about: 'Take DeepSeek Harness with you. Work with documents, write code, control your phone, and research on the go.',
    abiTitle: 'Which architecture should I download?',
    abiHelp: 'Choose arm64 for most Android phones, or x86_64 for compatible Android emulators. Browser detection is a recommendation. An incorrect architecture may prevent the engine from starting; use “Change architecture” to select another package.',
    installTitle: 'Installation',
    installHelp: 'Open the downloaded APK and allow your browser to install apps when prompted. Updates preserve data when signed with the same key. Follow the in-app guide to configure your model.',
    slowTitle: 'FAQ · Slow or failed download',
    slowHelp: 'A route is selected automatically between the official source and accelerated mirrors. If a download fails, use “Switch” below the download button to try the other source. A probe timeout does not mean a download is unavailable.',
    safetyTitle: 'FAQ · Package integrity',
    safetyHelp: 'This site does not host or modify packages. Expand “Installation and verification” to check the filename and SHA-256. MANIFEST.txt on the release page contains the complete checksums.',
    history: 'All releases', upstream: 'Upstream project', privacy: 'No cookies or analytics.',
    loading: 'Loading release information…', download: 'Download APK',
    official: 'Official source', mirror: 'Accelerated mirror', auto: 'Automatic', switch: 'Switch',
    source: 'Download source', automatic: 'Automatic routing', manual: 'Manual selection',
    checking: 'Selecting a route', uncertain: 'Probe inconclusive; you can switch manually',
    phone: 'For most Android phones', emulator: 'For x86_64 Android emulators',
    chooseAbi: 'Choose the installation device', changeAbi: 'Change architecture',
    arm: 'Phone · arm64', x86: 'Emulator · x86_64',
    inferred: 'Recommended architecture', detected: 'Detected architecture', selected: 'Selected architecture',
    unsupported: 'This device is not supported', unsupportedHelp: '64-bit arm64 and x86_64 packages are available.',
    noAsset: 'No matching package in this release', error: 'Release data is unavailable. Download from the release page.',
    verification: 'Installation and verification', file: 'Filename',
    missingHash: 'No inline checksum is available. Check MANIFEST.txt on the release page.',
    copy: 'Copy SHA-256', copied: 'Copied', copyFailed: 'Copy failed. Select the checksum to copy it.',
  },
};
export const t = key => messages[locale][key] || key;
export function translatePage() {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  const button = document.getElementById('language');
  if (button) {
    button.textContent = locale === 'zh' ? 'English' : '中文';
    button.setAttribute('aria-label', locale === 'zh' ? 'Switch to English' : '切换为中文');
  }
}
export function toggleLocale() {
  locale = locale === 'zh' ? 'en' : 'zh';
  translatePage();
}
