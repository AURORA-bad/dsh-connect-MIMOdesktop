/**
 * dsh-mimo-connect — browser half.
 *
 * Three seats, one store of truth (the node half's routes):
 *
 *   1. a remaining-quota readout in the composer dock, shown **only while the
 *      session is routed to MiMo** — a DeepSeek turn has nothing to do with the
 *      MiMo allowance, and a figure sitting in the composer during unrelated
 *      work is noise;
 *   2. a Settings page ("MiMo") holding the account pool, the model list, the
 *      switches and the diagnostics;
 *   3. an optional sidebar row that opens the same page in the centre column.
 *
 * Everything the page shows comes from `/api/mimo.settings`, `/api/mimo.pool`
 * and `/api/mimo.quota` — this half holds no state of its own and never talks to
 * the gateway. That is deliberate: the credential lives in the node process, so
 * a token must never be able to reach the page.
 *
 * The bundle is hand-written plain JS in the built `__ModuleLoader__.load`
 * shape. The host serves it at `/plugins` from the package's `./client` export,
 * discovered through the `dsh.client` declaration in package.json.
 *
 * @module dsh-connect-MIMOdesktop/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-connect-MIMOdesktop',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useState } = react

    /** Provider id this plugin owns; must match MIMO_PROVIDER in src/catalog.js. */
    const MIMO_PROVIDER = 'mimo'

    /** Exact routes the node half registers. */
    const QUOTA_ROUTE = '/api/mimo.quota'
    const SETTINGS_ROUTE = '/api/mimo.settings'
    const POOL_ROUTE = '/api/mimo.pool'
    const TEST_ROUTE = '/api/mimo.test'

    /** Poll cadence while the readout is visible. */
    const REFRESH_MS = 60 * 1000

    /** Cadence for re-reading placement/visibility settings from the pill. */
    const PREFS_POLL_MS = 10 * 1000

    /** Id of this plugin's Settings nav row and of the sidebar page. */
    const SECTION_ID = 'dsh-connect-MIMOdesktop'
    const PANEL_ID = 'dsh-connect-MIMOdesktop'

    const NS = 'mimo'

    // 文案刻意保持中性：不再声称「桌面端免费额度」。免费额度已经取消，而现在
    // 走订阅制，`percent` 的语义（剩余 / 已用 / 周期占比）尚未用真实订阅账号
    // 核实。与其写一个可能已经不准的说明，不如只说这是 MiMo 的额度读数。
    const zh = {
      'quota.label': 'MiMo 剩余 {percent}%',
      'quota.title': 'MiMo 额度剩余 {percent}%',
      'quota.reset': '重置于 {date}',
      'quota.refreshing': '正在刷新 MiMo 额度',
      'nav.panel': 'MiMo',
      'nav.section': 'MiMo',
      'section.accounts': '账号池',
      'section.models': '模型',
      'section.switches': '开关',
      'section.diagnostics': '诊断',
      'accounts.empty': '还没有账号。填入 MiMo 的 passToken（可留空使用桌面端登录态）。',
      'accounts.hint':
        'MiMo 没有账号清单接口，这里是本地名册：注册多个账号后，被网关拒绝的账号会冷却 5 分钟并自动切换到下一个。',
      'accounts.passToken': 'passToken',
      'accounts.label': '备注',
      'accounts.add': '添加账号',
      'accounts.remove': '删除',
      'accounts.activate': '设为当前',
      'accounts.active': '当前',
      'accounts.cooling': '冷却中',
      'accounts.inPool': '参与轮换',
      'accounts.path': '名册文件',
      'models.empty': '模型清单为空。',
      'models.all': '全部启用',
      'models.none': '全部关闭',
      'models.hint': '取消勾选的模型不会出现在模型选择器里。',
      'switch.providerEnabled': '启用 MiMo 提供方',
      'switch.providerEnabled.hint': '关闭后不再注册提供方、不再轮询，页面保留以便重新打开。',
      'switch.showQuotaInComposer': '在输入框旁显示额度',
      'switch.showQuotaInComposer.hint': '只在会话路由到 MiMo 时显示。',
      'select.quotaPlacement': '额度显示位置',
      'select.quotaPlacement.hint': '输入框内（模型选择器前）或输入框下方（统计行）。',
      'placement.input': '输入框内',
      'placement.dock': '输入框下方',
      'switch.sidebarPanel': '在侧边栏显示 MiMo 面板',
      'switch.sidebarPanel.hint': '在左侧导航加一行，打开同一张设置页。',
      'switch.pollIntervalMs': '刷新间隔',
      'diag.test': '测试连通性',
      'diag.testing': '正在测试…',
      'diag.test.ok': '连通正常（{ms}ms）',
      'diag.test.fail': '失败：{error}',
      'diag.test.model': '用于测试的模型',
      'diag.reload': '刷新',
      'diag.signedIn': '登录状态',
      'diag.signedIn.yes': '已登录',
      'diag.signedIn.no': '未登录',
      'diag.registered': '提供方已注册',
      'diag.yes': '是',
      'diag.no': '否',
      'diag.source': '凭据来源',
      'diag.models': '模型来源',
      'diag.none': '无',
      'common.save': '保存',
      'common.saving': '保存中…',
      'common.failed': '保存失败：{error}',
      'common.loading': '加载中…',
      'poll.1': '1 分钟',
      'poll.5': '5 分钟',
      'poll.10': '10 分钟',
      'poll.30': '30 分钟',
      'poll.60': '1 小时',
    }

    const en = {
      'quota.label': 'MiMo {percent}% left',
      'quota.title': 'MiMo quota: {percent}% remaining',
      'quota.reset': 'Resets {date}',
      'quota.refreshing': 'Refreshing MiMo quota',
      'nav.panel': 'MiMo',
      'nav.section': 'MiMo',
      'section.accounts': 'Accounts',
      'section.models': 'Models',
      'section.switches': 'Switches',
      'section.diagnostics': 'Diagnostics',
      'accounts.empty': 'No accounts yet. Paste a MiMo passToken (or leave it blank to use the desktop app login).',
      'accounts.hint':
        'MiMo exposes no account-list endpoint, so this is a local roster: register several accounts and one the gateway refuses cools down for five minutes while the next takes over.',
      'accounts.passToken': 'passToken',
      'accounts.label': 'Label',
      'accounts.add': 'Add account',
      'accounts.remove': 'Remove',
      'accounts.activate': 'Make current',
      'accounts.active': 'Current',
      'accounts.cooling': 'Cooling down',
      'accounts.inPool': 'In rotation',
      'accounts.path': 'Roster file',
      'models.empty': 'The model list is empty.',
      'models.all': 'Enable all',
      'models.none': 'Disable all',
      'models.hint': 'An unchecked model is left out of the model picker.',
      'switch.providerEnabled': 'Enable the MiMo provider',
      'switch.providerEnabled.hint': 'Off means no provider and no polling; this page stays so it can be turned back on.',
      'switch.showQuotaInComposer': 'Show the quota beside the composer',
      'switch.showQuotaInComposer.hint': 'Only while the session is routed to MiMo.',
      'select.quotaPlacement': 'Quota readout placement',
      'select.quotaPlacement.hint': 'Inside the composer before the model picker, or in the stats row below it.',
      'placement.input': 'Inside composer',
      'placement.dock': 'Below composer',
      'switch.sidebarPanel': 'Show a MiMo panel in the sidebar',
      'switch.sidebarPanel.hint': 'Adds a row to the left nav that opens this same page.',
      'switch.pollIntervalMs': 'Refresh interval',
      'diag.test': 'Test connection',
      'diag.testing': 'Testing…',
      'diag.test.ok': 'Reachable ({ms}ms)',
      'diag.test.fail': 'Failed: {error}',
      'diag.test.model': 'Model to test',
      'diag.reload': 'Reload',
      'diag.signedIn': 'Sign-in',
      'diag.signedIn.yes': 'Signed in',
      'diag.signedIn.no': 'Not signed in',
      'diag.registered': 'Provider registered',
      'diag.yes': 'Yes',
      'diag.no': 'No',
      'diag.source': 'Credential source',
      'diag.models': 'Model source',
      'diag.none': 'none',
      'common.save': 'Save',
      'common.saving': 'Saving…',
      'common.failed': 'Save failed: {error}',
      'common.loading': 'Loading…',
      'poll.1': '1 minute',
      'poll.5': '5 minutes',
      'poll.10': '10 minutes',
      'poll.30': '30 minutes',
      'poll.60': '1 hour',
    }

    /** Label for one poll choice, keyed by minutes. */
    const POLL_LABELS = { 60000: 'poll.1', 300000: 'poll.5', 600000: 'poll.10', 1800000: 'poll.30', 3600000: 'poll.60' }

    /**
     * Styles.
     *
     * Rendered as a React element by each component rather than appended to
     * `document.head`, because the host's `claimStyles` attributes every
     * untagged `<style>` in the document to whichever plugin is materializing
     * and then removes them when that plugin unloads.
     */
    const PILL_CSS = `
.mimoq_pill{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.mimoq_pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.mimoq_anchor{min-width:0;display:inline-flex}
.mimoq_dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.55}
.mimoq_dotWarn{opacity:1;background:var(--dsw-alias-state-warning-primary,currentColor)}
.mimoq_dotLow{opacity:1;background:var(--dsw-alias-state-error-primary,currentColor)}
.mimoq_label{min-width:0;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
`

    const PAGE_CSS = `
.mimos_page{display:flex;flex-direction:column;gap:20px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary);font-size:13px}
.mimos_card{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.24));border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.mimos_cardHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.mimos_title{font-weight:600;font-size:13px;margin:0}
.mimos_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;margin:0}
.mimos_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mimos_rowTop{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.mimos_grow{flex:1;min-width:0}
.mimos_label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.mimos_input{box-sizing:border-box;min-width:0;flex:1;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.32));background:var(--dsw-alias-bg-secondary,transparent);color:inherit;font:inherit}
.mimos_input option{background-color:Canvas;color:CanvasText}
.mimos_input option:checked{background-color:Highlight;color:HighlightText}
.mimos_btn{box-sizing:border-box;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.32));background:0 0;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
.mimos_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mimos_btn:disabled{opacity:.5;cursor:default}
.mimos_btnPrimary{border-color:var(--dsw-alias-state-success-primary,currentColor)}
.mimos_list{display:flex;flex-direction:column;gap:8px}
.mimos_item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.08))}
.mimos_itemMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.mimos_itemName{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mimos_itemMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mimos_tag{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.32));color:var(--dsw-alias-label-tertiary)}
.mimos_tagOn{color:var(--dsw-alias-state-success-primary,currentColor);border-color:currentColor}
.mimos_modelList{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px}
.mimos_check{display:flex;align-items:center;gap:8px;font-size:12px;min-width:0}
.mimos_check span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mimos_err{color:var(--dsw-alias-state-error-primary,#d33);font-size:12px}
.mimos_ok{color:var(--dsw-alias-state-success-primary,#2a8);font-size:12px}
.mimos_code{font-family:ui-monospace,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
`

    /**
     * Validate a quota payload from the node half.
     *
     * @param value - the decoded response body.
     * @returns the reading, or undefined when there is nothing to show.
     */
    function readQuota(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
      if (value.available !== true) return undefined
      if (typeof value.percent !== 'number' || !Number.isFinite(value.percent)) return undefined
      return value
    }

    /**
     * Format the remaining share.
     *
     * One decimal throughout, at most: rounding to whole percent would hide the
     * small decrements a single turn actually costs on a large allowance, which
     * is precisely what this readout exists to show. A true 100 stays compact
     * so an untouched account does not read as "100.0%".
     */
    function formatPercent(percent) {
      const clamped = Math.min(100, Math.max(0, percent))
      if (clamped >= 99.95) return '100'
      const fixed = clamped.toFixed(1)
      return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
    }

    /** Read the provider a model directory currently routes to. */
    function providerOf(directory) {
      try {
        return directory.getSnapshot()?.current?.provider
      } catch {
        return undefined
      }
    }

    /** GET a JSON route, returning undefined on any failure. */
    function getJson(route, signal) {
      return fetch(route, { signal })
        .then(response => (response.ok ? response.json() : undefined))
        .catch(() => undefined)
    }

    /** POST a JSON body, returning the decoded reply (never throws). */
    function postJson(route, body, signal) {
      return fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
        .then(response => response.json().catch(() => undefined))
        .catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    }

    /**
     * The remaining-quota pill.
     *
     * Renders nothing unless the session's current route is MiMo *and* a figure
     * is available, so an unrelated conversation never grows a control for a
     * quota it is not spending.
     */
    function QuotaPill({ directory, t, sessionId, position }) {
      const [routed, setRouted] = useState(() => providerOf(directory) === MIMO_PROVIDER)
      const [quota, setQuota] = useState(undefined)
      // Placement/visibility live in settings. The renderer caches inject
      // results per entry, so a value closed over at registration would never
      // update; read it here instead. Defaults mirror SETTINGS_DEFAULTS so a
      // failed read keeps the pill visible rather than hiding it.
      const [prefs, setPrefs] = useState({ showQuotaInComposer: true, quotaPlacement: 'dock' })

      const refresh = useCallback(signal => {
        return fetch(QUOTA_ROUTE, { signal })
          .then(response => (response.ok ? response.json() : undefined))
          .then(body => {
            if (signal.aborted) return
            setQuota(readQuota(body))
          })
          .catch(() => {
            // Offline, aborted, or signed out: show nothing rather than an error.
            if (!signal.aborted) setQuota(undefined)
          })
      }, [])

      // Follow the session's model selection.
      useEffect(() => {
        if (directory === undefined) {
          setRouted(false)
          return undefined
        }
        const sync = () => setRouted(providerOf(directory) === MIMO_PROVIDER)
        sync()
        return directory.subscribe(sync)
      }, [directory])

      // Re-read placement/visibility on a short cadence so a switch on the
      // settings page answers within seconds; a failed read keeps the last
      // known prefs.
      useEffect(() => {
        const controller = new AbortController()
        const read = () => {
          if (controller.signal.aborted) return
          fetch(SETTINGS_ROUTE, { signal: controller.signal })
            .then(response => (response.ok ? response.json() : undefined))
            .then(body => {
              if (controller.signal.aborted || body?.values === undefined) return
              setPrefs({
                showQuotaInComposer: body.values.showQuotaInComposer !== false,
                quotaPlacement: body.values.quotaPlacement === 'input' ? 'input' : 'dock',
              })
            })
            .catch(() => {})
        }
        read()
        const timer = setInterval(read, PREFS_POLL_MS)
        return () => {
          clearInterval(timer)
          controller.abort()
        }
      }, [])

      // This instance renders only in the seat the setting names; the other
      // seat's instance stays mounted and returns null.
      const visible = routed && prefs.showQuotaInComposer !== false && prefs.quotaPlacement === position

      // Fetch only while this seat is visible, and keep the figure fresh while it is.
      useEffect(() => {
        if (!visible) {
          setQuota(undefined)
          return undefined
        }
        const controller = new AbortController()
        refresh(controller.signal)
        const timer = setInterval(() => {
          if (!controller.signal.aborted) refresh(controller.signal)
        }, REFRESH_MS)
        return () => {
          clearInterval(timer)
          controller.abort()
        }
      }, [visible, refresh])

      if (!visible || quota === undefined) return null

      const percent = formatPercent(quota.percent)
      const label = t('quota.label', { percent })
      const title =
        quota.resetDate === undefined
          ? t('quota.title', { percent })
          : `${t('quota.title', { percent })} · ${t('quota.reset', { date: quota.resetDate })}`
      const tone = quota.percent <= 5 ? 'mimoq_dotLow' : quota.percent <= 20 ? 'mimoq_dotWarn' : undefined

      return h(
        react.Fragment,
        null,
        h('style', { key: 'css', 'data-plugin-css': 'dsh-connect-MIMOdesktop/QuotaPill.module.css' }, PILL_CSS),
        h(
          'span',
          {
            key: 'pill',
            className: 'mimoq_anchor',
            'data-mimo-quota': true,
            'data-session-id': sessionId,
          },
          h(
            'span',
            { className: 'mimoq_pill', title, 'aria-label': title, role: 'note' },
            h('span', {
              className: tone === undefined ? 'mimoq_dot' : `mimoq_dot ${tone}`,
              'aria-hidden': true,
            }),
            h('span', { className: 'mimoq_label' }, label),
          ),
        ),
      )
    }

    /** A small inline MiMo glyph, drawn rather than shipped as an asset. */
    function MimoIcon({ size }) {
      const edge = typeof size === 'number' ? size : 16
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', {
          x: 1.5,
          y: 3.5,
          width: 13,
          height: 9,
          rx: 2.5,
          stroke: 'currentColor',
          strokeWidth: 1.3,
        }),
        h('path', {
          d: 'M4.5 10V6.6l1.9 2.2 1.9-2.2V10',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M10.6 6.6V10',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * The Settings page.
     *
     * Reads and writes through the node half's routes. `settingsScope` is
     * deliberately NOT used: the host's settings mirror differs between host
     * lines, and this plugin's own route is one code path on both.
     */
    function MimoPage({ t }) {
      const [settings, setSettings] = useState(undefined)
      const [accounts, setAccounts] = useState([])
      const [poolPath, setPoolPath] = useState('')
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState(undefined)

      // The add-account form.
      const [passToken, setPassToken] = useState('')
      const [label, setLabel] = useState('')

      // The probe.
      const [probeModel, setProbeModel] = useState('')
      const [probe, setProbe] = useState(undefined)
      const [probing, setProbing] = useState(false)

      const reload = useCallback(signal => {
        return Promise.all([getJson(SETTINGS_ROUTE, signal), getJson(POOL_ROUTE, signal)]).then(
          ([settingsBody, poolBody]) => {
            if (signal?.aborted === true) return
            if (settingsBody?.ok === true) {
              setSettings(settingsBody)
              setProbeModel(current => current.length > 0 ? current : settingsBody.catalog?.[0]?.id ?? '')
            }
            if (poolBody?.ok === true) {
              setAccounts(poolBody.accounts ?? [])
              setPoolPath(poolBody.path ?? '')
            }
          },
        )
      }, [])

      useEffect(() => {
        const controller = new AbortController()
        reload(controller.signal)
        return () => controller.abort()
      }, [reload])

      /** Write one setting field and adopt the reply. */
      const save = useCallback(
        (field, value) => {
          setError(undefined)
          setBusy(field)
          return postJson(SETTINGS_ROUTE, { field, value })
            .then(reply => {
              if (reply?.ok !== true) {
                setError(reply?.error ?? 'unknown error')
                return
              }
              setSettings(current =>
                current === undefined
                  ? current
                  : { ...current, values: { ...current.values, [field]: reply.value } },
              )
            })
            .finally(() => setBusy(undefined))
        },
        [],
      )

      /** Run one pool action and adopt the returned roster. */
      const poolAction = useCallback(body => {
        setError(undefined)
        setBusy(body.action)
        return postJson(POOL_ROUTE, body)
          .then(reply => {
            if (reply?.ok !== true) {
              setError(reply?.error ?? 'unknown error')
              return
            }
            setAccounts(reply.accounts ?? [])
          })
          .finally(() => setBusy(undefined))
      }, [])

      const values = settings?.values
      const catalog = settings?.catalog ?? []
      const enabledModels = values?.enabledModels
      const enabledSet = useMemo(
        () => (Array.isArray(enabledModels) ? new Set(enabledModels) : undefined),
        [enabledModels],
      )

      if (settings === undefined) {
        return h('div', { className: 'mimos_page' }, t('common.loading'))
      }

      /** Toggle one model in the enabled list. */
      const toggleModel = id => {
        const base = enabledSet === undefined ? catalog.map(entry => entry.id) : [...enabledSet]
        const next = base.includes(id) ? base.filter(x => x !== id) : [...base, id]
        // An untouched list means "all"; keep that meaning when the new set is
        // exactly the whole catalog, so a later catalog addition stays visible.
        const isAll = next.length === catalog.length
        save('enabledModels', isAll ? null : next)
      }

      return h(
        react.Fragment,
        null,
        h('style', { key: 'css', 'data-plugin-css': 'dsh-connect-MIMOdesktop/MimoPage.module.css' }, PAGE_CSS),
        h(
          'div',
          { className: 'mimos_page', 'data-mimo-page': true },

          error === undefined ? null : h('div', { className: 'mimos_err' }, error),

          // ---- Accounts -------------------------------------------------
          h(
            'section',
            { className: 'mimos_card' },
            h(
              'div',
              { className: 'mimos_cardHead' },
              h('h3', { className: 'mimos_title' }, t('section.accounts')),
              h(
                'button',
                { className: 'mimos_btn', onClick: () => reload(), disabled: busy !== undefined },
                t('diag.reload'),
              ),
            ),
            h('p', { className: 'mimos_hint' }, t('accounts.hint')),
            accounts.length === 0
              ? h('p', { className: 'mimos_hint' }, t('accounts.empty'))
              : h(
                  'div',
                  { className: 'mimos_list' },
                  ...accounts.map(account =>
                    h(
                      'div',
                      { className: 'mimos_item', key: account.id },
                      h(
                        'div',
                        { className: 'mimos_itemMain' },
                        h(
                          'span',
                          { className: 'mimos_itemName' },
                          account.label.length > 0 ? account.label : account.id,
                        ),
                        h(
                          'span',
                          { className: 'mimos_itemMeta' },
                          `${account.cUserId.length > 0 ? account.cUserId : account.id} · ${account.passTokenMasked}`,
                        ),
                      ),
                      account.active
                        ? h('span', { className: 'mimos_tag mimos_tagOn' }, t('accounts.active'))
                        : null,
                      account.cooling
                        ? h('span', { className: 'mimos_tag' }, t('accounts.cooling'))
                        : null,
                      account.active
                        ? null
                        : h(
                            'button',
                            {
                              className: 'mimos_btn',
                              disabled: busy !== undefined,
                              onClick: () => poolAction({ action: 'activate', id: account.id }),
                            },
                            t('accounts.activate'),
                          ),
                      h(
                        'button',
                        {
                          className: 'mimos_btn',
                          disabled: busy !== undefined,
                          onClick: () => poolAction({ action: 'remove', id: account.id }),
                        },
                        t('accounts.remove'),
                      ),
                    ),
                  ),
                ),
            h(
              'div',
              { className: 'mimos_row' },
              h('input', {
                className: 'mimos_input',
                placeholder: t('accounts.passToken'),
                value: passToken,
                spellCheck: false,
                autoComplete: 'off',
                onChange: event => setPassToken(event.target.value),
              }),
              h('input', {
                className: 'mimos_input',
                placeholder: t('accounts.label'),
                value: label,
                onChange: event => setLabel(event.target.value),
              }),
              h(
                'button',
                {
                  className: 'mimos_btn mimos_btnPrimary',
                  disabled: busy !== undefined || passToken.trim().length === 0,
                  onClick: () =>
                    poolAction({ action: 'add', passToken: passToken.trim(), label }).then(() => {
                      setPassToken('')
                      setLabel('')
                    }),
                },
                t('accounts.add'),
              ),
            ),
            poolPath.length === 0
              ? null
              : h('p', { className: 'mimos_code' }, `${t('accounts.path')}: ${poolPath}`),
          ),

          // ---- Models ---------------------------------------------------
          h(
            'section',
            { className: 'mimos_card' },
            h(
              'div',
              { className: 'mimos_cardHead' },
              h('h3', { className: 'mimos_title' }, t('section.models')),
              h(
                'div',
                { className: 'mimos_row' },
                h(
                  'button',
                  { className: 'mimos_btn', disabled: busy !== undefined, onClick: () => save('enabledModels', null) },
                  t('models.all'),
                ),
                h(
                  'button',
                  { className: 'mimos_btn', disabled: busy !== undefined, onClick: () => save('enabledModels', []) },
                  t('models.none'),
                ),
              ),
            ),
            h('p', { className: 'mimos_hint' }, t('models.hint')),
            catalog.length === 0
              ? h('p', { className: 'mimos_hint' }, t('models.empty'))
              : h(
                  'div',
                  { className: 'mimos_modelList' },
                  ...catalog.map(entry =>
                    h(
                      'label',
                      { className: 'mimos_check', key: entry.id },
                      h('input', {
                        type: 'checkbox',
                        checked: enabledSet === undefined || enabledSet.has(entry.id),
                        disabled: busy !== undefined,
                        onChange: () => toggleModel(entry.id),
                      }),
                      h('span', { title: entry.id }, entry.name),
                    ),
                  ),
                ),
          ),

          // ---- Switches -------------------------------------------------
          h(
            'section',
            { className: 'mimos_card' },
            h('h3', { className: 'mimos_title' }, t('section.switches')),
            ...[
              ['providerEnabled', 'switch.providerEnabled'],
              ['showQuotaInComposer', 'switch.showQuotaInComposer'],
              ['sidebarPanel', 'switch.sidebarPanel'],
            ].map(([field, key]) =>
              h(
                'div',
                { className: 'mimos_rowTop', key: field },
                h(
                  'div',
                  { className: 'mimos_grow' },
                  h('div', { className: 'mimos_label' }, t(key)),
                  h('p', { className: 'mimos_hint' }, t(`${key}.hint`)),
                ),
                h('input', {
                  type: 'checkbox',
                  checked: values[field] === true,
                  disabled: busy !== undefined,
                  onChange: event => save(field, event.target.checked),
                }),
              ),
            ),
            h(
              'div',
              { className: 'mimos_rowTop' },
              h(
                'div',
                { className: 'mimos_grow' },
                h('div', { className: 'mimos_label' }, t('switch.pollIntervalMs')),
              ),
              h(
                'select',
                {
                  className: 'mimos_input',
                  style: { flex: '0 0 auto' },
                  value: String(values.pollIntervalMs),
                  disabled: busy !== undefined,
                  onChange: event => save('pollIntervalMs', Number(event.target.value)),
                },
                ...(settings.pollChoices ?? []).map(ms =>
                  h('option', { value: String(ms), key: ms }, t(POLL_LABELS[ms] ?? String(ms))),
                ),
              ),
            ),
            h(
              'div',
              { className: 'mimos_rowTop' },
              h(
                'div',
                { className: 'mimos_grow' },
                h('div', { className: 'mimos_label' }, t('select.quotaPlacement')),
                h('p', { className: 'mimos_hint' }, t('select.quotaPlacement.hint')),
              ),
              h(
                'select',
                {
                  className: 'mimos_input',
                  style: { flex: '0 0 auto' },
                  value: values.quotaPlacement === 'input' ? 'input' : 'dock',
                  disabled: busy !== undefined,
                  onChange: event => save('quotaPlacement', event.target.value),
                },
                h('option', { value: 'dock', key: 'dock' }, t('placement.dock')),
                h('option', { value: 'input', key: 'input' }, t('placement.input')),
              ),
            ),
          ),

          // ---- Diagnostics ----------------------------------------------
          h(
            'section',
            { className: 'mimos_card' },
            h('h3', { className: 'mimos_title' }, t('section.diagnostics')),
            h(
              'div',
              { className: 'mimos_row' },
              h('span', { className: 'mimos_label' }, t('diag.test.model')),
              h(
                'select',
                {
                  className: 'mimos_input',
                  value: probeModel,
                  onChange: event => setProbeModel(event.target.value),
                },
                ...catalog.map(entry => h('option', { value: entry.id, key: entry.id }, entry.name)),
              ),
              h(
                'button',
                {
                  className: 'mimos_btn',
                  disabled: probing || probeModel.length === 0,
                  onClick: () => {
                    setProbing(true)
                    setProbe(undefined)
                    postJson(TEST_ROUTE, { model: probeModel })
                      .then(reply => setProbe(reply))
                      .finally(() => setProbing(false))
                  },
                },
                probing ? t('diag.testing') : t('diag.test'),
              ),
            ),
            probe === undefined
              ? null
              : probe.ok === true
                ? h('p', { className: 'mimos_ok' }, t('diag.test.ok', { ms: probe.elapsedMs }))
                : h(
                    'p',
                    { className: 'mimos_err' },
                    t('diag.test.fail', { error: probe.error ?? probe.status ?? 'unknown' }),
                  ),
            h(
              'div',
              { className: 'mimos_row' },
              h('span', { className: 'mimos_label' }, t('diag.models')),
              h('span', { className: 'mimos_code' }, settings.catalogSource ?? t('diag.none')),
            ),
          ),
        ),
      )
    }

    /** Services required to register the dictionary and the slots. */
    const inject = ['slots', 'locale', 'modelDirectories']

    /**
     * Client plugin body.
     *
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-connect-MIMOdesktop: dictionaries')

      ctx.inject(['slots', 'modelDirectories'], scope => {
        const models = scope.modelDirectories

        // The composer readouts. Both seats register unconditionally: which one
        // renders is a setting, and re-registering a seat on every settings
        // change would be a flicker for a switch a user flips once.
        scope.slots.inject('conversation.composer.dock', () =>
          scope.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'mimo-quota',
              // The built-in stats pills sit at order 0; land just after them so
              // the row reads: session stats, then quota, then the row ends.
              order: 10,
              locale: NS,
              inject: sessionId => {
                const directory = models.directoryFor(sessionId)
                return { sessionId, directory: directory?.store, position: 'dock' }
              },
            },
            QuotaPill,
          ),
        )

        // Inside the composer, before the model picker. QuotaPill renders only
        // in the seat `quotaPlacement` names, so both entries stay registered
        // and a settings change needs no re-register (the renderer caches inject
        // results per entry; a fresh registration would never re-evaluate).
        scope.slots.inject('conversation.input.right', () =>
          scope.slots.register(
            {
              name: 'conversation.input.right',
              id: 'mimo-quota-input',
              // Before the model picker; order 4 leaves room for other plugins.
              order: 4,
              locale: NS,
              inject: sessionId => {
                const directory = models.directoryFor(sessionId)
                return { sessionId, directory: directory?.store, position: 'input' }
              },
            },
            QuotaPill,
          ),
        )
      })

      // The Settings page.
      //
      // `settings.section` is a list slot keyed by an id this plugin owns; the
      // shell renders `settings.section.icon` for the same id, so a page without
      // its icon shows a blank nav row.
      try {
        ctx.slots.inject('settings.section', () => {
          const disposers = []
          disposers.push(
            ctx.slots.register(
              {
                name: 'settings.section',
                id: SECTION_ID,
                order: 35,
                label: () => 'MiMo',
                locale: NS,
                inject: () => ({ surface: 'settings' }),
              },
              MimoPage,
            ),
          )
          try {
            disposers.push(
              ctx.slots.inject('settings.section.icon', () =>
                ctx.slots.register(
                  { name: 'settings.section.icon', id: SECTION_ID, locale: NS },
                  iconProps => h(MimoIcon, { size: iconProps?.size }),
                ),
              ),
            )
          } catch (error) {
            // A missing icon slot leaves the nav row without a glyph; the page
            // itself still works, so this is never fatal.
            console.warn('[dsh-connect-MIMOdesktop] settings nav icon failed to register', error)
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose()
              } catch {}
            }
          }
        })
      } catch (error) {
        console.error('[dsh-connect-MIMOdesktop] settings section failed to register', error)
      }

      // The page the sidebar row opens.
      //
      // `sidebar.panellist` rows point at a `main` page keyed by the same id, so
      // the page is registered unconditionally and only the ROW comes and goes
      // with the switch. Registering the page alongside the row would mean
      // disposing the page whenever the switch is flipped, which loses whatever
      // the user was typing in the add-account field.
      try {
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ surface: 'panel' }) },
            MimoPage,
          ),
        )
      } catch (error) {
        console.error('[dsh-connect-MIMOdesktop] panel page failed to register', error)
      }

      // The optional sidebar row, gated by `sidebarPanel`.
      //
      // `sidebar.panellist` builds its rows from ENTRY METADATA, so a component
      // returning null leaves a blank-but-clickable button rather than no
      // button. The row therefore has to be registered only while the switch is
      // on, which is what this effect owns.
      let panelDisposers = []
      let panelWanted
      const syncPanel = () => {
        for (const dispose of panelDisposers) {
          try {
            dispose()
          } catch {}
        }
        panelDisposers = []
        if (panelWanted !== true) return
        try {
          panelDisposers.push(
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: PANEL_ID, order: 2, label: () => 'MiMo', locale: NS },
                iconProps => h(MimoIcon, { size: iconProps?.size }),
              ),
            ),
          )
        } catch (error) {
          console.error('[dsh-connect-MIMOdesktop] sidebar panel row failed to register', error)
        }
      }

      const readPanelWanted = signal => {
        getJson(SETTINGS_ROUTE, signal).then(body => {
          if (signal?.aborted === true || body?.ok !== true) return
          const next = body.values?.sidebarPanel === true
          if (next === panelWanted) return
          panelWanted = next
          syncPanel()
        })
      }
      ctx.effect(() => {
        const controller = new AbortController()
        readPanelWanted(controller.signal)
        // Cheap and bounded: the switch is flipped from the page, and there is
        // no settings-changed event to subscribe to.
        const timer = setInterval(() => {
          if (!controller.signal.aborted) readPanelWanted(controller.signal)
        }, 15000)
        return () => {
          clearInterval(timer)
          controller.abort()
          for (const dispose of panelDisposers) {
            try {
              dispose()
            } catch {}
          }
          panelDisposers = []
        }
      }, 'dsh-connect-MIMOdesktop: sidebar panel')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
