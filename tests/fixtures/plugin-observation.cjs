// 发布与启动验证共用的手工观测夹具，不调用生产报告生成器。
function pluginObservation(packages) {
  const runtimes = {
    autoreboot: { shellSyntaxExit: 0, configReadable: true,
      generatedSchedule: '17 3 * * 2 sleep 5 && touch /etc/banner && reboot #autoreboot_smoke', installedSchedule: false },
    autoupdate: { shellSyntaxExit: 0, luaSyntaxExit: 0, configReadable: true, metadataReadable: true },
    'kucat-config': { shellSyntaxExit: 0, configReadable: true,
      applied: { mode: 'dark', primary_rgbm: '26,131,97', font_d: '1.3rem' } },
  };
  const asset = resource => ({ path: resource, status: 200, bytes: 128, sha256: 'a'.repeat(64),
    ...(resource.endsWith('.js') ? { syntax: 'valid' } : {}) });
  return {
    schema: 1, scope: 'isolated-local-smoke',
    plugins: Object.fromEntries(packages.filter(name => name.startsWith('luci-app-')).map(name => {
      const family = name.slice(9);
      if (!runtimes[family]) throw new Error('夹具没有此插件的观测: ' + name);
      const view = family === 'kucat-config' ? 'kucat-config/config' : family;
      const ui = family === 'autoupdate'
        ? { kind: 'status', route: '/cgi-bin/luci/admin/system/autoupdate/check_status',
          status: 200, authenticated: true, payload: { running: false, is_upgrading: false, success: false }, mainForm: 'not_tested' }
        : { kind: 'view', route: '/cgi-bin/luci/admin/system/' + family, view, status: 200, authenticated: true,
          assets: [asset('/luci-static/resources/view/' + view + '.js')] };
      return [name, { runtime: runtimes[family], ui }];
    })),
    theme: { name: 'kucat', mediaurlbase: '/luci-static/kucat', htmlUsesTheme: true,
      assets: [asset('/luci-static/kucat/css/style.css')] },
    cleanup: { configurationsRestored: true, cronUnchanged: true, processesStopped: true },
    coverage: { browserInteraction: 'not_tested', externalServices: 'not_tested', firmwareUpgrade: 'not_tested',
      scheduledReboot: 'not_tested', transparentProxy: 'not_tested', frpcTunnel: 'not_tested', frpcAdminApi: 'not_tested' },
  };
}

module.exports = { pluginObservation };
