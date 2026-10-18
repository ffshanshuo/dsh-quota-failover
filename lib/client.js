/**
 * dsh-quota-failover — client half.
 *
 * Registers one Settings section ("额度转移") that talks to the host route
 * `/_quota-failover` exposed by `lib/index.js`. Everything the panel edits lands
 * in `$DSH_HOME/quota-failover.config.json`, which the host re-reads on every
 * failed request — so saving here takes effect immediately, no restart and no
 * plugin reload.
 *
 * Deliberately dependency-light: `react` only. The UI primitives package is an
 * optional seat in some DSH builds; a panel that vanishes because a peer is
 * unresolvable is worse than a plain one, so all controls are plain DOM with
 * inline styling tuned for the dark shell.
 */
window.__ModuleLoader__.load({
	id: 'dsh-quota-failover',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require('react');
		var h = react.createElement;

		var ENDPOINT = '/_quota-failover';

		// ---------------------------------------------------------------- //
		// palette                                                          //
		// ---------------------------------------------------------------- //
		var C = {
			text: '#e8e8ea',
			dim: '#9a9aa2',
			muted: '#8b8b94',
			faint: '#6d6d75',
			line: '#33333c',
			panel: '#1c1c21',
			field: '#141418',
			accent: '#4c8dff',
			ok: '#43c08a',
			warn: '#e0a44a',
			err: '#e4676b',
		};

		var S = {
			wrap: { display: 'flex', flexDirection: 'column', gap: '18px', color: C.text, fontSize: '13px', lineHeight: 1.55 },
			card: { background: C.panel, border: '1px solid ' + C.line, borderRadius: '10px', padding: '14px 16px' },
			cardTitle: { fontSize: '12px', fontWeight: 600, letterSpacing: '.04em', color: C.dim, textTransform: 'uppercase', marginBottom: '10px' },
			row: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '7px 0' },
			rowLabel: { width: '190px', flex: '0 0 190px', color: C.dim, paddingTop: '2px' },
			rowBody: { flex: '1 1 auto', minWidth: 0 },
			hint: { color: C.muted, fontSize: '12px', marginTop: '4px' },
			input: { width: '100%', boxSizing: 'border-box', background: C.field, border: '1px solid ' + C.line, borderRadius: '6px', color: C.text, padding: '7px 9px', fontSize: '13px', outline: 'none', fontFamily: 'inherit' },
			area: { width: '100%', boxSizing: 'border-box', background: C.field, border: '1px solid ' + C.line, borderRadius: '6px', color: C.text, padding: '8px 9px', fontSize: '12.5px', outline: 'none', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.6, resize: 'vertical' },
			btn: { background: C.field, border: '1px solid ' + C.line, borderRadius: '6px', color: C.text, padding: '7px 14px', fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' },
			btnPrimary: { background: C.accent, border: '1px solid ' + C.accent, borderRadius: '6px', color: '#fff', padding: '7px 16px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
			btnDanger: { background: C.field, border: '1px solid rgba(228,103,107,.55)', borderRadius: '6px', color: C.err, padding: '7px 14px', fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' },
			btnDangerArm: { background: 'rgba(228,103,107,.16)', border: '1px solid rgba(228,103,107,.8)', borderRadius: '6px', color: C.err, padding: '7px 14px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
			btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
			btnSm: { background: C.field, border: '1px solid ' + C.line, borderRadius: '6px', color: C.text, padding: '3px 9px', fontSize: '12px', cursor: 'pointer', fontFamily: 'inherit' },
			btnOn: { background: 'rgba(76,141,255,.16)', border: '1px solid rgba(76,141,255,.6)', borderRadius: '999px', color: C.text, padding: '3px 10px', fontSize: '12px', cursor: 'pointer', fontFamily: 'inherit' },
			subTitle: { fontSize: '12.5px', fontWeight: 600, color: C.text, margin: '16px 0 6px' },
			section: { marginTop: '16px', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,.05)' },
			groupHeader: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', margin: '14px 0 4px', paddingBottom: '6px', borderBottom: '1px solid ' + C.line },
			scroll: { maxHeight: '430px', overflowY: 'auto', overflowX: 'hidden', paddingRight: '4px' },
			search: { background: C.field, border: '1px solid ' + C.line, borderRadius: '6px', color: C.text, padding: '5px 8px', fontSize: '12.5px', outline: 'none', fontFamily: 'inherit', width: '200px' },
			opt: { display: 'flex', gap: '9px', alignItems: 'flex-start', padding: '6px 9px', border: '1px solid ' + C.line, borderRadius: '7px', cursor: 'pointer', marginBottom: '6px' },
			optOn: { borderColor: C.accent, background: 'rgba(76,141,255,.10)' },
			badge: { display: 'inline-block', padding: '1px 7px', borderRadius: '999px', fontSize: '11.5px', border: '1px solid ' + C.line, color: C.dim },
			table: { width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' },
			th: { textAlign: 'left', color: C.faint, fontWeight: 500, padding: '5px 8px', borderBottom: '1px solid ' + C.line, whiteSpace: 'nowrap' },
			td: { padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,.045)', verticalAlign: 'top', wordBreak: 'break-all' },
			tabs: { display: 'flex', gap: '4px', flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 5, background: 'linear-gradient(180deg, rgba(20,20,24,.98), rgba(20,20,24,.92))', padding: '6px 0 8px', borderBottom: '1px solid ' + C.line },
			saveBar: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', position: 'sticky', top: '44px', zIndex: 4, background: 'linear-gradient(180deg, rgba(20,20,24,.97), rgba(20,20,24,.9))', padding: '8px 0 10px', borderBottom: '1px solid ' + C.line },
			tab: { background: 'transparent', border: '1px solid transparent', borderRadius: '7px', color: C.dim, padding: '6px 12px', fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' },
			tabOn: { background: 'rgba(76,141,255,.14)', border: '1px solid rgba(76,141,255,.5)', borderRadius: '7px', color: C.text, padding: '6px 12px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
			summary: { background: C.field, border: '1px solid ' + C.line, borderRadius: '8px', padding: '7px 10px', minWidth: '118px', flex: '0 1 auto' },
			summaryLabel: { color: C.faint, fontSize: '11.5px' },
			summaryValue: { fontSize: '12.5px', marginTop: '2px', wordBreak: 'break-word' },
		};

		// ---------------------------------------------------------------- //
		// host API                                                         //
		// ---------------------------------------------------------------- //
		function call(path, method, body) {
			var init = { method: method || 'GET', headers: {} };
			if (body !== undefined) {
				init.headers['content-type'] = 'application/json';
				init.body = JSON.stringify(body);
			}
			// A call that never settles would pin the panel on its loading state
			// forever, which is exactly what a missing Host route used to look like.
			var controller = typeof AbortController === 'function' ? new AbortController() : null;
			var timer = null;
			if (controller !== null) {
				init.signal = controller.signal;
				timer = setTimeout(function () { controller.abort(); }, 12000);
			}
			var settle = function () { if (timer !== null) { clearTimeout(timer); timer = null; } };
			return fetch(ENDPOINT + path, init).then(function (res) {
				return res.text().then(function (text) {
					settle();
					var parsed;
					try { parsed = text.length > 0 ? JSON.parse(text) : {}; } catch (e) { parsed = { ok: false, error: text.slice(0, 400) }; }
					if (!res.ok && parsed && !parsed.error) parsed.error = 'HTTP ' + res.status;
					return parsed;
				}, function (error) {
					settle();
					throw error;
				});
			}, function (error) {
				settle();
				if (error && error.name === 'AbortError') throw new Error('宿主 12 秒内没有响应 /_quota-failover' + path);
				throw error;
			});
		}

		function routesToText(list) {
			return (list || []).map(function (r) { return r.provider + '/' + r.model; }).join('\n');
		}

		function textToRoutes(text) {
			var out = [];
			var seen = {};
			String(text || '').split(/\r?\n/).forEach(function (line) {
				var trimmed = line.trim();
				if (trimmed.length === 0) return;
				var slash = trimmed.indexOf('/');
				if (slash <= 0 || slash === trimmed.length - 1) return;
				if (seen[trimmed]) return;
				seen[trimmed] = true;
				out.push({ provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) });
			});
			return out;
		}

		// ---------------------------------------------------------------- //
		// panel                                                            //
		// ---------------------------------------------------------------- //
		function Panel() {
			var stateHook = react.useState(null); // server state
			var state = stateHook[0], setState = stateHook[1];
			var draftHook = react.useState(null);
			var draft = draftHook[0], setDraft = draftHook[1];
			var statusHook = react.useState({ kind: 'idle', text: '' });
			var status = statusHook[0], setStatus = statusHook[1];
			var busyHook = react.useState(false);
			var busy = busyHook[0], setBusy = busyHook[1];
			var probeHook = react.useState({ running: false, results: null, text: '', done: 0, total: 0 });
			var probe = probeHook[0], setProbe = probeHook[1];
			var inventoryHook = react.useState({ loading: true, routes: [], providers: [], total: 0, source: '正在读取…', note: '', hostJob: false });
			var inventory = inventoryHook[0], setInventory = inventoryHook[1];
			// Persisted availability results: the Host keeps them in
			// $DSH_HOME/quota-failover-probe.json so they survive refreshes and are
			// readable by agents through the `route_availability` tool. An older Host
			// has no such store; those results live in localStorage instead.
			var resultsHook = react.useState({ loading: true, results: null, error: '' });
			var results = resultsHook[0], setResults = resultsHook[1];
			var allowlistHook = react.useState({ loading: true, enabled: false, total: 0, routes: [], providers: [], note: '', source: '' });
			var allowlist = allowlistHook[0], setAllowlist = allowlistHook[1];
			// Which providers the next sweep covers. Initialised once, to the subagent
			// model whitelist, because that is the set the user already authorised.
			// `touched` records a manual edit: only then does the default stop following
			// later whitelist updates.
			var scopeHook = react.useState({ checked: {}, initialized: false, touched: false });
			var scope = scopeHook[0], setScope = scopeHook[1];
			// Combos: cross-provider routes built from model categories. The Host keeps
			// them in $DSH_HOME/quota-failover-combos.json and registers them as one
			// provider (`failover-combos`), so they show up in 设置 → 模型 like any other
			// model. Older Hosts have no `/combos` endpoint at all.
			var combosHook = react.useState({ loading: true, error: '', note: '', provider: '', path: '', updatedAt: '', combos: [], categories: [], stats: [], hidden: 0 });
			var combos = combosHook[0], setCombos = combosHook[1];
			var comboPickHook = react.useState({});
			var comboPick = comboPickHook[0], setComboPick = comboPickHook[1];
			var comboBusyHook = react.useState(false);
			var comboBusy = comboBusyHook[0], setComboBusy = comboBusyHook[1];
			var comboMsgHook = react.useState({ kind: '', text: '' });
			var comboMsg = comboMsgHook[0], setComboMsg = comboMsgHook[1];
			// Which member scope the next "生成组合" call uses: 'all' = every catalog
			// route, 'whitelist' = only routes authorised for subagents. The filter
			// block below decides it per row, so this is only a display hint.
			var comboFilterHook = react.useState({ providers: [], whitelistOnly: true, singles: false });
			var comboFilter = comboFilterHook[0], setComboFilter = comboFilterHook[1];
			// Generated combos start collapsed: the list grows quickly and the panel
			// is mostly used for the category picks.
			var comboOpenHook = react.useState(false);
			var comboOpen = comboOpenHook[0], setComboOpen = comboOpenHook[1];
			// "删除全部" cannot be undone from the panel, so it arms first: the first
			// click turns the button into a confirmation, the second one deletes.
			var comboArmHook = react.useState(false);
			var comboArm = comboArmHook[0], setComboArm = comboArmHook[1];
			// Destructive actions arm first: one click asks, the second one acts.
			var resetArmHook = react.useState(false);
			var resetArm = resetArmHook[0], setResetArm = resetArmHook[1];
			var deleteArmHook = react.useState(null);
			var deleteArm = deleteArmHook[0], setDeleteArm = deleteArmHook[1];
			// Availability filter shared by both combo lists (generated combos and
			// model categories): a multi-select over probe verdict buckets. Empty
			// selection means "no availability filtering at all".
			var comboAvailabilityHook = react.useState([]);
			var comboAvailability = comboAvailabilityHook[0], setComboAvailability = comboAvailabilityHook[1];
			// Hundreds of combos are a supported state, so the expanded list is
			// searchable and paged instead of rendering everything at once.
			var comboQueryHook = react.useState('');
			var comboQuery = comboQueryHook[0], setComboQuery = comboQueryHook[1];
			var comboShowAllHook = react.useState(50);
			var comboLimit = comboShowAllHook[0], setComboLimit = comboShowAllHook[1];
			var COMBO_PAGE_SIZE = 50;
			// Active tab. Every tab stays mounted (inactive ones are display:none),
			// so switching never throws away list scroll position or half-typed input.
			var tabHook = react.useState(readStoredTab);
			var tab = tabHook[0], setTabState = tabHook[1];

			function setTab(key) {
				setTabState(key);
				storeTab(key);
			}

			function absorb(payload) {
				if (!payload || payload.ok !== true) {
					var reason = payload && payload.error;
					setStatus({
						kind: 'error',
						text: reason
							? '无法读取插件状态：' + reason
							: '无法读取插件状态：宿主没有注册 /_quota-failover 接口（插件刚更新过的话，需要重启 DSH）',
					});
					return;
				}
				setState(payload);
				setDraft({
					enabled: payload.config.enabled,
					mode: payload.config.mode,
					notify: payload.config.notify,
					respectAllowlist: payload.config.respectAllowlist,
					candidatesText: routesToText(payload.config.candidates),
					stickyMinutes: Math.round((payload.config.stickyMs || 0) / 60000),
					journal: payload.config.journal,
				});
			}

			react.useEffect(function () {
				var alive = true;
				call('/state').then(function (payload) {
					if (!alive) return;
					absorb(payload);
					setStatus({ kind: 'idle', text: '' });
				}).catch(function (e) {
					if (alive) setStatus({ kind: 'error', text: '宿主接口不可达：' + String(e && e.message ? e.message : e) });
				});
				return function () { alive = false; };
			}, []);

			/** Flatten the Host's provider-grouped model catalog into `{provider, model}` rows. */
			function routesOfCatalog(catalog) {
				var routes = [];
				var providers = [];
				var groups = Array.isArray(catalog && catalog.groups) ? catalog.groups : [];
				groups.forEach(function (group) {
					if (!group || typeof group.id !== 'string') return;
					var models = Array.isArray(group.models) ? group.models : [];
					if (models.length === 0) return;
					providers.push({ provider: group.id, count: models.length });
					models.forEach(function (model) {
						if (model && typeof model.id === 'string') routes.push({ provider: group.id, model: model.id });
					});
				});
				return { routes: routes, providers: providers };
			}

			/** Fill the inventory from the RPC catalog — the only path a pre-b4 Host offers. */
			function loadInventoryFromCatalog() {
				var remote = pluginCtx && pluginCtx.remote;
				var service = remote && remote.session;
				if (!service || typeof service.modelCatalog !== 'function') {
					setInventory({ loading: false, routes: [], providers: [], total: 0, source: '不可用', note: '这个客户端没有暴露 session.modelCatalog', hostJob: false });
					return;
				}
				service.modelCatalog().then(function (reply) {
					if (!reply || reply.ok !== true) {
						var message = (reply && reply.error && reply.error.message) || '宿主没有返回模型目录';
						setInventory({ loading: false, routes: [], providers: [], total: 0, source: '读取失败', note: message, hostJob: false });
						return;
					}
					var parsed = routesOfCatalog(reply.value);
					setInventory({
						loading: false,
						routes: parsed.routes,
						providers: parsed.providers,
						total: parsed.routes.length,
						source: '会话模型目录',
						note: parsed.routes.length === 0 ? '宿主当前没有登记任何可路由模型' : '',
						hostJob: false,
					});
				}).catch(function (e) {
					setInventory({ loading: false, routes: [], providers: [], total: 0, source: '读取失败', note: String(e && e.message ? e.message : e), hostJob: false });
				});
			}

			/**
			 * Every route this Host can currently hand to an agent — the same set the model
			 * selector offers. A b4 Host answers from its adapter registry; older Hosts 404
			 * there and we fall back to the session model catalog over RPC.
			 */
			function loadInventory() {
				setInventory({ loading: true, routes: [], providers: [], total: 0, source: '正在读取…', note: '', hostJob: false });
				call('/routes').then(function (payload) {
					if (payload && payload.ok === true && Array.isArray(payload.providers) && payload.total > 0) {
						var routes = [];
						var providers = [];
						var broken = 0;
						payload.providers.forEach(function (row) {
							if (!row || !Array.isArray(row.routes) || row.routes.length === 0) {
								if (row && row.error) broken += 1;
								return;
							}
							providers.push({ provider: row.provider, count: row.routes.length });
							row.routes.forEach(function (route) {
								if (route && typeof route.provider === 'string' && typeof route.model === 'string') {
									routes.push({ provider: route.provider, model: route.model });
								}
							});
						});
						setInventory({
							loading: false,
							routes: routes,
							providers: providers,
							total: routes.length,
							source: '宿主注册表',
							note: broken > 0 ? broken + ' 个 provider 未公布模型清单' : '',
							hostJob: true,
						});
						return;
					}
					loadInventoryFromCatalog();
				}).catch(function () {
					loadInventoryFromCatalog();
				});
			}

			react.useEffect(function () {
				loadInventory();
			}, []);

			var LOCAL_RESULTS_KEY = 'dsh-quota-failover-probe';
			// Largest sweep one Host job accepts. Bigger selections are split into
			// consecutive batches automatically — nothing is silently dropped.
			var PROBE_LIMIT = 200;

			function readLocalResults() {
				try {
					var raw = window.localStorage.getItem(LOCAL_RESULTS_KEY);
					if (!raw) return null;
					var parsed = JSON.parse(raw);
					if (!parsed || !Array.isArray(parsed.routes)) return null;
					return parsed;
				} catch (e) {
					return null;
				}
			}

			function writeLocalResults(value) {
				try { window.localStorage.setItem(LOCAL_RESULTS_KEY, JSON.stringify(value)); } catch (e) { /* storage may be off */ }
			}

			/**
			 * Prefer the Host store: it is the same file the `route_availability` tool
			 * reads, so the panel and any agent see identical evidence. Older Hosts 404
			 * there and we fall back to the browser-local copy.
			 */
			function loadResults() {
				call('/probe/results').then(function (payload) {
					if (payload && payload.ok === true && payload.results && Array.isArray(payload.results.routes)) {
						setResults({ loading: false, results: payload.results, error: '' });
						writeLocalResults(payload.results);
						return;
					}
					setResults({ loading: false, results: readLocalResults(), error: '' });
				}).catch(function () {
					setResults({ loading: false, results: readLocalResults(), error: '' });
				});
			}

			/**
			 * The subagent model whitelist as the *Client* sees it: the very setting card
			 * the user edits under 设置 → 内置插件 → 子智能体. Reading it from the config
			 * form means the default probe scope is right even while the Host still runs an
			 * older plugin build that has no `/allowlist` endpoint — and it stays current
			 * when the user edits that card in another tab.
			 */
			function whitelistFromConfigForms() {
				try {
					var forms = pluginCtx && pluginCtx.configForms;
					var scope = forms && typeof forms.get === 'function'
						? forms.get('subagent-model-selection-settings')
						: null;
					if (!scope || typeof scope.getSnapshot !== 'function') return null;
					var snapshot = scope.getSnapshot();
					if (!snapshot || snapshot.status !== 'ready' || !snapshot.value) return null;
					var rows = Array.isArray(snapshot.value.allowedModels) ? snapshot.value.allowedModels : [];
					var routes = [];
					var counts = {};
					rows.forEach(function (route) {
						if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string') return;
						routes.push({ provider: route.provider, model: route.model });
						counts[route.provider] = (counts[route.provider] || 0) + 1;
					});
					var providers = Object.keys(counts).sort().map(function (id) {
						return { id: id, count: counts[id] };
					});
					return {
						loading: false,
						enabled: snapshot.value.enabled === true,
						total: routes.length,
						routes: routes,
						providers: providers,
						note: '',
						source: 'settings',
					};
				} catch (e) {
					// A build without the settings transport simply has no config form to read.
					return null;
				}
			}

			function describeAllowlistFailure(text) {
				var raw = String(text || '');
				if (raw.indexOf('HTTP 404') === 0) {
					return '宿主还没重启：读取白名单的接口是 0.2.2 才有的，重启 DSH 后这里改由宿主回答。';
				}
				return raw;
			}

			/** The subagent model whitelist — the default probe scope, because it is what the user already authorised. */
			function loadAllowlist() {
				var fromSettings = whitelistFromConfigForms();
				if (fromSettings !== null) {
					setAllowlist(fromSettings);
					return;
				}
				call('/allowlist').then(function (payload) {
					if (payload && payload.ok === true) {
						setAllowlist({
							loading: false,
							enabled: payload.enabled === true,
							total: payload.total || 0,
							routes: Array.isArray(payload.routes) ? payload.routes : [],
							providers: Array.isArray(payload.providers) ? payload.providers : [],
							note: payload.note || '',
							source: payload.source || 'host',
						});
						return;
					}
					setAllowlist({ loading: false, enabled: false, total: 0, routes: [], providers: [], note: describeAllowlistFailure((payload && payload.error) || '宿主没有返回白名单'), source: '' });
				}).catch(function (e) {
					setAllowlist({ loading: false, enabled: false, total: 0, routes: [], providers: [], note: '读取白名单失败：' + String(e && e.message ? e.message : e), source: '' });
				});
			}

			/** Fold one finished sweep into the panel store and keep it across refreshes. */
			function absorbProbeRows(rows) {
				var at = new Date().toISOString();
				var stamped = (rows || []).map(function (row) {
					return Object.assign({}, row, { at: row && row.at ? row.at : at });
				});
				setResults({ loading: false, results: { version: 1, testedAt: at, routes: stamped }, error: '' });
				writeLocalResults({ version: 1, testedAt: at, routes: stamped });
				// A Host with the results store has just persisted the same sweep; read it
				// back so routes tested in earlier sessions are merged in, not replaced.
				call('/probe/results').then(function (payload) {
					if (payload && payload.ok === true && payload.results && Array.isArray(payload.results.routes)
						&& payload.results.routes.length >= stamped.length) {
						setResults({ loading: false, results: payload.results, error: '' });
						writeLocalResults(payload.results);
					}
				}).catch(function () { /* an old Host simply keeps the browser copy */ });
			}

			react.useEffect(function () {
				loadResults();
				loadAllowlist();
			}, []);

			// The whitelist can change while this panel stays open (same card that owns the
			// setting). Subscribe so the default scope always reflects the latest save.
			react.useEffect(function () {
				var unsubscribe = null;
				try {
					var forms = pluginCtx && pluginCtx.configForms;
					var scope = forms && typeof forms.get === 'function'
						? forms.get('subagent-model-selection-settings')
						: null;
					if (scope && typeof scope.subscribe === 'function') {
						unsubscribe = scope.subscribe(function () { loadAllowlist(); });
					}
				} catch (e) { /* no settings transport on this build */ }
				return function () {
					try { if (typeof unsubscribe === 'function') unsubscribe(); } catch (e) { /* already disposed */ }
				};
			}, []);

			/** Union of every provider the panel knows about, with whitelist/inventory/tested counts. */
			function providerRows() {
				var map = {};
				var touch = function (id) {
					if (typeof id !== 'string' || id.length === 0) return null;
					if (!map[id]) map[id] = { provider: id, whitelist: 0, inventory: 0, tested: 0 };
					return map[id];
				};
				(allowlist.providers || []).forEach(function (row) {
					if (!row || typeof row.id !== 'string') return;
					var entry = touch(row.id);
					if (entry) entry.whitelist = row.count || 0;
				});
				(inventory.providers || []).forEach(function (row) {
					if (!row || typeof row.provider !== 'string') return;
					var entry = touch(row.provider);
					if (entry) entry.inventory = row.count || 0;
				});
				var testedCount = {};
				var storedRows = results && results.results && Array.isArray(results.results.routes) ? results.results.routes : [];
				storedRows.forEach(function (row) {
					if (!row || typeof row.provider !== 'string') return;
					testedCount[row.provider] = (testedCount[row.provider] || 0) + 1;
				});
				Object.keys(testedCount).forEach(function (id) {
					var entry = touch(id);
					if (entry) entry.tested = testedCount[id];
				});
				return Object.keys(map).sort().map(function (id) { return map[id]; });
			}

			/** Whitelist models when this provider is whitelisted; its advertised catalog otherwise. */
			function routesForProvider(id) {
				var whitelist = (allowlist.routes || []).filter(function (route) { return route && route.provider === id; });
				var pool = whitelist.length > 0 ? whitelist : (inventory.routes || []).filter(function (route) { return route && route.provider === id; });
				var seen = {};
				var out = [];
				pool.forEach(function (route) {
					if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string') return;
					var key = route.provider + '/' + route.model;
					if (seen[key]) return;
					seen[key] = true;
					out.push({ provider: route.provider, model: route.model });
				});
				return out;
			}

			function checkedProviders() {
				return providerRows().filter(function (row) { return scope.checked[row.provider] === true; });
			}

			function providersTargetCount() {
				var total = 0;
				checkedProviders().forEach(function (row) { total += routesForProvider(row.provider).length; });
				return total;
			}

			function toggleProvider(id) {
				var next = Object.assign({}, scope.checked);
				next[id] = next[id] !== true;
				setScope({ checked: next, initialized: true, touched: true });
			}

			function checkAllProviders(flag) {
				var next = {};
				providerRows().forEach(function (row) { next[row.provider] = flag === true; });
				setScope({ checked: next, initialized: true, touched: true });
			}

			function checkWhitelistProviders() {
				var next = {};
				(allowlist.providers || []).forEach(function (row) {
					if (row && typeof row.id === 'string') next[row.id] = true;
				});
				if (Object.keys(next).length === 0) {
					providerRows().forEach(function (row) { next[row.provider] = true; });
				}
				setScope({ checked: next, initialized: true, touched: true });
			}

			/**
			 * Default the checkboxes to the subagent whitelist. The whitelist arrives
			 * asynchronously (it is read from the settings transport once that is ready), so
			 * keep re-defaulting until the user touches a checkbox.
			 */
			react.useEffect(function () {
				if (scope.touched === true) return;
				if (allowlist.loading === true || inventory.loading === true) return;
				var next = {};
				(allowlist.providers || []).forEach(function (row) {
					if (row && typeof row.id === 'string') next[row.id] = true;
				});
				if (Object.keys(next).length === 0) {
					(inventory.providers || []).forEach(function (row) {
						if (row && typeof row.provider === 'string') next[row.provider] = true;
					});
				}
				var before = Object.keys(scope.checked).filter(function (id) { return scope.checked[id] === true; }).sort().join('\n');
				var after = Object.keys(next).filter(function (id) { return next[id] === true; }).sort().join('\n');
				if (scope.initialized === true && before === after) return;
				setScope({ checked: next, initialized: true, touched: false });
			}, [allowlist.loading, allowlist.total, inventory.loading, inventory.total, scope.touched]);

			function runProbeSelected() {
				var chosen = checkedProviders();
				var targets = [];
				chosen.forEach(function (row) { targets = targets.concat(routesForProvider(row.provider)); });
				if (targets.length === 0) {
					setStatus({ kind: 'error', text: '没有可测试的路由：勾选的 provider 没有公布模型清单，白名单也为空。' });
					return;
				}
				var batches = targets.length > PROBE_LIMIT ? Math.ceil(targets.length / PROBE_LIMIT) : 1;
				var phase = '测试选中的 ' + chosen.length + ' 个 provider（共 ' + targets.length + ' 条'
					+ (batches > 1 ? '，自动分 ' + batches + ' 批' : '') + '）';
				probeInBatches(targets, phase, { routes: targets, timeoutMs: PROBE_TIMEOUT_MS });
			}

			/** Re-test one provider in place, so a stale ✓ can be confirmed or corrected. */
			function probeProvider(providerId) {
				var targets = routesForProvider(providerId);
				if (targets.length === 0) {
					setStatus({ kind: 'error', text: '没有可测试的路由：' + providerId + ' 没有公布模型清单，白名单也为空。' });
					return;
				}
				var batches = targets.length > PROBE_LIMIT ? Math.ceil(targets.length / PROBE_LIMIT) : 1;
				probeInBatches(targets, '重测 ' + providerId + (batches > 1 ? '（自动分 ' + batches + ' 批）' : ''),
					{ scope: 'candidates', routes: targets, timeoutMs: PROBE_TIMEOUT_MS });
			}

			/** Latest learned verdict per provider, sorted — what the results table renders. */
			function resultsByProvider() {
				var rows = results && results.results && Array.isArray(results.results.routes) ? results.results.routes : [];
				var map = {};
				rows.forEach(function (row) {
					if (!row || typeof row.provider !== 'string') return;
					if (!map[row.provider]) map[row.provider] = { provider: row.provider, rows: [], lastAt: '' };
					map[row.provider].rows.push(row);
					if (typeof row.at === 'string' && row.at > map[row.provider].lastAt) map[row.provider].lastAt = row.at;
				});
				var now = Date.now();
				return Object.keys(map).sort().map(function (id) {
					var group = map[id];
					group.rows.sort(function (a, b) { return String(a.model).localeCompare(String(b.model)); });
					group.ok = group.rows.filter(function (row) { return row.ok === true; }).length;
					group.runtime = group.rows.filter(function (row) { return row.source === 'runtime'; }).length;
					group.stale = group.lastAt !== '' && (now - Date.parse(group.lastAt) > PROBE_STALE_MS);
					return group;
				});
			}

			function patch(next) {
				setDraft(Object.assign({}, draft, next));
			}

			function save() {
				if (!draft) return;
				var candidates = textToRoutes(draft.candidatesText);
				if (draft.mode === 'auto' && candidates.length === 0) {
					setStatus({ kind: 'error', text: '自动切换模式至少需要一条候选路由。' });
					return;
				}
				var stickyMs = Math.max(0, Math.round((Number(draft.stickyMinutes) || 0) * 60000));
				setBusy(true);
				call('/config', 'POST', {
					enabled: draft.enabled,
					mode: draft.mode,
					notify: draft.notify,
					respectAllowlist: draft.respectAllowlist,
					candidates: candidates,
					stickyMs: stickyMs,
					journal: draft.journal,
				}).then(function (payload) {
					setBusy(false);
					absorb(payload);
					if (payload && payload.ok === true) setStatus({ kind: 'ok', text: '已保存，下一次请求失败即生效。' });
				}).catch(function (e) {
					setBusy(false);
					setStatus({ kind: 'error', text: '保存失败：' + String(e && e.message ? e.message : e) });
				});
			}

			function reset() {
				setBusy(true);
				call('/reset', 'POST', {}).then(function (payload) {
					setBusy(false);
					absorb(payload);
					if (payload && payload.ok === true) setStatus({ kind: 'ok', text: '已恢复默认配置。' });
				}).catch(function (e) {
					setBusy(false);
					setStatus({ kind: 'error', text: '恢复失败：' + String(e && e.message ? e.message : e) });
				});
			}

			/** Resetting drops every saved setting, so it asks for a second click first. */
			function requestReset() {
				if (resetArm !== true) {
					setResetArm(true);
					setStatus({ kind: 'error', text: '再点一次「确认恢复默认」就会重置全部配置（候选链、模式、白名单开关等）。' });
					return;
				}
				setResetArm(false);
				reset();
			}

			function clearEvents() {
				call('/journal/clear', 'POST', {}).then(function () { return call('/state'); }).then(absorb).catch(function () {});
			}

			// A single Host request can probe several routes; four keeps one slow batch from
			// eating the whole timeout budget while still finishing a large sweep quickly.
			var PROBE_CHUNK = 4;
			var PROBE_TIMEOUT_MS = 15000;
			var PROBE_POLL_MS = 800;
			// A verdict is a snapshot, not a promise: quota walls appear the moment an
			// account runs dry, so a clean sweep goes stale while it is still displayed.
			var PROBE_STALE_MS = 15 * 60 * 1000;

			// The panel is one long column of cards; tabs keep everything reachable
			// without scrolling past unrelated cards. The choice is per browser, not
			// per Host, so it lives in localStorage rather than in the plugin config.
			var TAB_STORAGE_KEY = 'quota-failover.active-tab';
			var TABS = [
				{ key: 'status', label: '状态' },
				{ key: 'failure', label: '失败处理' },
				{ key: 'combos', label: '模型组合' },
				{ key: 'availability', label: '可用性' },
				{ key: 'events', label: '事件' },
			];

			function readStoredTab() {
				try {
					var saved = window.localStorage.getItem(TAB_STORAGE_KEY);
					if (TABS.some(function (item) { return item.key === saved; })) return saved;
				} catch (error) { /* storage can be unavailable */ }
				return 'status';
			}

			function storeTab(key) {
				try { window.localStorage.setItem(TAB_STORAGE_KEY, key); } catch (error) { /* ignore */ }
			}

			function probeFailure(target, reason) {
				return { provider: target.provider, model: target.model, ok: false, kind: 'other', code: reason, ms: 0 };
			}

			/** Publish one finished result list in the shape the panel renders. */
			function settleProbe(rows, phase) {
				var good = rows.filter(function (row) { return row.ok === true; }).length;
				setProbe({ running: false, results: rows, text: '测试完成：' + good + '/' + rows.length + ' 条可用', done: rows.length, total: rows.length });
				absorbProbeRows(rows);
			}

			/** Follow a Host-side probe job (`POST /probe` + `GET /probe/state`) to completion. */
			function followJob(jobId, phase, onDone) {
				call('/probe/state').then(function (payload) {
					var job = payload && payload.ok === true ? payload.job : null;
					if (!job || (jobId !== null && job.id !== jobId)) {
						setProbe({ running: false, results: null, text: '宿主没有返回测试作业状态', done: 0, total: 0 });
						return;
					}
					var rows = Array.isArray(job.results) ? job.results.slice() : [];
					var good = rows.filter(function (row) { return row.ok === true; }).length;
					var running = job.running === true;
					setProbe({
						running: running,
						results: rows,
						text: running
							? phase + '：' + (job.done || rows.length) + '/' + (job.total || rows.length)
							: (job.cancelled === true
								? '测试被中止（已测 ' + (job.done || rows.length) + '/' + (job.total || rows.length) + '）：' + good + ' 条可用'
								: '测试完成：' + good + '/' + rows.length + ' 条可用'),
						done: job.done || rows.length,
						total: job.total || rows.length,
					});
					if (running) {
						setTimeout(function () { followJob(job.id, phase, onDone); }, PROBE_POLL_MS);
						return;
					}
					absorbProbeRows(rows);
					if (typeof onDone === 'function') onDone(rows);
				}).catch(function (e) {
					setProbe({ running: false, results: null, text: '读取进度失败：' + String(e && e.message ? e.message : e) });
				});
			}

			/** Start the Host's own sweep (b4 hosts) and follow it. */
			function startHostJob(body, phase, fallbackTargets, onDone) {
				setProbe({ running: true, results: null, text: phase + '：正在启动…', done: 0, total: fallbackTargets.length });
				call('/probe', 'POST', body).then(function (payload) {
					if (payload && payload.ok === true && payload.job) {
						followJob(payload.job.id, phase, onDone);
						return;
					}
					if (payload && Array.isArray(payload.results)) {
						settleProbe(payload.results, phase);
						if (typeof onDone === 'function') onDone(payload.results);
						return;
					}
					setProbe({ running: false, results: null, text: (payload && payload.error) || '宿主拒绝了测试请求', done: 0, total: 0 });
				}).catch(function (e) {
					setProbe({ running: false, results: null, text: '启动测试失败：' + String(e && e.message ? e.message : e), done: 0, total: 0 });
				});
			}

			/**
			 * Probe routes in small ordered batches and publish progress after every batch, so
			 * a sweep over a hundred routes still shows life immediately instead of after minutes.
			 * A b4 Host does the sweeping itself; the batching path covers older Hosts.
			 *
			 * When a Host sweep would exceed one job's limit, the panel runs consecutive Host
			 * jobs (200 routes each) and merges their results — a 700-route selection is
			 * tested completely, never truncated.
			 */
			function probeInBatches(targets, phase, jobBody) {
				if (targets.length === 0) {
					setProbe({ running: false, results: [], text: '没有可测试的路由。', done: 0, total: 0 });
					return;
				}
				if (inventory.hostJob === true && jobBody) {
					if (targets.length <= PROBE_LIMIT) {
						startHostJob(jobBody, phase, targets);
						return;
					}
					var batchCount = Math.ceil(targets.length / PROBE_LIMIT);
					var budget = targets.length;
					var gathered = [];
					var batchIndex = 0;
					setProbe({ running: true, results: null, text: phase + '：分 ' + batchCount + ' 批连续测，正在启动…', done: 0, total: budget });
					var nextBatch = function () {
						if (batchIndex >= batchCount) {
							settleProbe(gathered, phase);
							return;
						}
						var from = batchIndex * PROBE_LIMIT;
						var chunk = targets.slice(from, from + PROBE_LIMIT);
						batchIndex += 1;
						var label = phase + '（第 ' + batchIndex + '/' + batchCount + ' 批，共 ' + budget + ' 条）';
						startHostJob(Object.assign({}, jobBody, { routes: chunk, scope: 'candidates' }), label, chunk, function (rows) {
							rows.forEach(function (row) { gathered.push(row); });
							setProbe({
								running: batchIndex < batchCount,
								results: gathered.slice(),
								text: phase + '：' + gathered.length + '/' + budget,
								done: gathered.length,
								total: budget,
							});
							nextBatch();
						});
					};
					nextBatch();
					return;
				}
				var collected = [];
				var cursor = 0;
				setProbe({ running: true, results: null, text: phase + '：0/' + targets.length, done: 0, total: targets.length });

				var step = function () {
					if (cursor >= targets.length) {
						var good = collected.filter(function (row) { return row.ok === true; }).length;
						setProbe({ running: false, results: collected, text: '测试完成：' + good + '/' + collected.length + ' 条可用', done: collected.length, total: targets.length });
						absorbProbeRows(collected);
						return;
					}
					var batch = targets.slice(cursor, cursor + PROBE_CHUNK);
					cursor += batch.length;
					call('/probe', 'POST', { routes: batch, timeoutMs: PROBE_TIMEOUT_MS }).then(function (payload) {
						if (payload && payload.ok === true && Array.isArray(payload.results)) {
							payload.results.forEach(function (row) { collected.push(row); });
						} else {
							var why = (payload && payload.error) || '测试接口失败';
							batch.forEach(function (row) { collected.push(probeFailure(row, why)); });
						}
						step();
					}).catch(function (e) {
						var why = String(e && e.message ? e.message : e);
						batch.forEach(function (row) { collected.push(probeFailure(row, why)); });
						step();
					});
					setProbe({
						running: true,
						results: collected.slice(),
						text: phase + '：' + Math.min(cursor, targets.length) + '/' + targets.length,
						done: collected.length,
						total: targets.length,
					});
				};
				step();
			}

			/** Ask every route currently written in the candidate box whether it answers at all. */
			function runProbe() {
				probeInBatches(textToRoutes(draft.candidatesText), '测试候选路由', { scope: 'candidates', routes: textToRoutes(draft.candidatesText), timeoutMs: PROBE_TIMEOUT_MS });
			}

			/** Ask every route the Host can route — not only the ones already in the candidate box. */
			function runProbeAll() {
				var targets = inventory.routes || [];
				probeInBatches(targets, '测试全部路由', { scope: 'all', routes: targets, timeoutMs: PROBE_TIMEOUT_MS });
			}

			/** Copy the routes that answered into the candidate box (still needs 保存 to persist). */
			function fillCandidates() {
				var pool = (probe.results && probe.results.length > 0)
					? probe.results
					: (results && results.results && Array.isArray(results.results.routes) ? results.results.routes : []);
				var seen = {};
				var good = [];
				(pool || []).forEach(function (row) {
					if (!row || row.ok !== true) return;
					var key = row.provider + '/' + row.model;
					if (seen[key]) return;
					seen[key] = true;
					good.push(key);
				});
				patch({ candidatesText: good.join('\n') });
				setStatus({ kind: 'ok', text: '已把 ' + good.length + ' 条可用路由填入候选，点「保存」后生效。' });
			}

			var KIND_LABEL = {
				quota: '额度墙',
				'refusal': '账号不支持该模型',
				'route-refusal': '账号不支持该模型',
				soft: '临时故障',
				timeout: '超时',
				other: '其它错误',
			};

			// ------------------------------------------------------------ //
			// combos                                                       //
			// ------------------------------------------------------------ //
			function comboEndpointMissing(payload) {
				var error = payload && payload.error ? String(payload.error) : '';
				return error.indexOf('HTTP 404') === 0 || error.indexOf('no such endpoint') >= 0;
			}

			function comboStateFrom(payload) {
				return {
					loading: false,
					error: '',
					note: payload.note || '',
					provider: payload.provider || 'failover-combos',
					path: payload.path || '',
					updatedAt: payload.updatedAt || '',
					combos: Array.isArray(payload.combos) ? payload.combos : [],
					categories: Array.isArray(payload.categories) ? payload.categories : [],
					stats: Array.isArray(payload.stats) ? payload.stats : [],
					hidden: payload.hidden || 0,
				};
			}

			/**
			 * Client-side mirror of the Host model classifier: the panel also needs
			 * category keys for routes that only the whitelist mentions (and for
			 * single-source rows the Host hides), so it can apply its own filters
			 * without another round-trip.
			 */
			var AGGREGATE_KEYS = { auto: true, free: true, random: true, default: true };
			function categoryKeyClient(modelId) {
				var name = String(modelId || '');
				var slash = name.lastIndexOf('/');
				if (slash >= 0) name = name.slice(slash + 1);
				name = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
				name = name.replace(/^sn-/, '').replace(/^stealth-/, '').replace(/^free-/, '');
				name = name.replace(/-contributor-free$/, '').replace(/-contributor$/, '').replace(/-free$/, '');
				name = name.replace(/^-+/, '').replace(/-+$/, '');
				return AGGREGATE_KEYS[name] === true ? '' : name;
			}

			function prettyFromKeyClient(key) {
				return String(key || '').split('-').map(function (part) {
					if (part.length === 0) return '';
					return part.charAt(0).toUpperCase() + part.slice(1);
				}).join(' ');
			}

			function routeSignature(member) {
				return member.provider + '\u0000' + member.model;
			}

			/**
			 * Merge the Host's category rows with two client-side sources:
			 * - the Host model catalog (so single-source rows can appear when asked),
			 * - the subagent whitelist (so whitelist-only rows appear even when the
			 *   Host hid them because they cannot form a cross-provider combo).
			 */
			function buildComboRows() {
				var byKey = {};
				function rowFor(key) {
					if (byKey[key] === undefined) {
						byKey[key] = { key: key, name: '', members: [], whiteMembers: [] };
					}
					return byKey[key];
				}
				(combos.categories || []).forEach(function (row) {
					if (!row || typeof row.key !== 'string' || row.key.length === 0) return;
					var target = rowFor(row.key);
					target.name = row.name || target.name;
					target.selected = row.selected === true;
					target.enabled = row.enabled;
					(target.members || []).forEach(function (member) {
						if (!member || typeof member.provider !== 'string' || typeof member.model !== 'string') return;
						if (!target.members.some(function (m) { return routeSignature(m) === routeSignature(member); })) target.members.push({ provider: member.provider, model: member.model });
					});
					(target.whiteMembers || []).forEach(function (member) {
						if (!member || typeof member.provider !== 'string' || typeof member.model !== 'string') return;
						if (!target.whiteMembers.some(function (m) { return routeSignature(m) === routeSignature(member); })) target.whiteMembers.push({ provider: member.provider, model: member.model });
					});
				});
				(inventory.routes || []).forEach(function (route) {
					if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string') return;
					var key = categoryKeyClient(route.model);
					if (key.length === 0) return;
					var target = rowFor(key);
					if (!target.members.some(function (m) { return routeSignature(m) === routeSignature(route); })) target.members.push({ provider: route.provider, model: route.model });
				});
				(allowlist.routes || []).forEach(function (route) {
					if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string') return;
					var key = categoryKeyClient(route.model);
					if (key.length === 0) return;
					var target = rowFor(key);
					if (!target.whiteMembers.some(function (m) { return routeSignature(m) === routeSignature(route); })) target.whiteMembers.push({ provider: route.provider, model: route.model });
				});
				var rows = [];
				Object.keys(byKey).forEach(function (key) {
					var row = byKey[key];
					if (row.name.length === 0) row.name = prettyFromKeyClient(key);
					row.count = row.members.length;
					row.providers = row.members.length > 0 ? row.members.reduce(function (list, member) {
						if (list.indexOf(member.provider) < 0) list.push(member.provider);
						return list;
					}, []).length : 0;
					row.whiteCount = row.whiteMembers.length;
					rows.push(row);
				});
				return rows;
			}

			/** The routes a combo generated from this row would use, given current filters. */
			function rowScope(row) {
				if (comboFilter.whitelistOnly === true) return 'whitelist';
				if (row.members.length === 0) return 'whitelist';
				return 'all';
			}

			function rowPool(row) {
				if (rowScope(row) === 'whitelist') return row.whiteMembers;
				return row.members;
			}

			function rowMembers(row) {
				var picked = comboFilter.providers || [];
				return rowPool(row).filter(function (member) {
					return picked.length === 0 || picked.indexOf(member.provider) >= 0;
				});
			}

			/** Rows that pass the three filters: provider, whitelist-only, single-source. */
			function filteredComboRows(override) {
				var filter = override || comboFilter;
				var availability = probeRouteIndex();
				var minSources = filter.singles === true ? 1 : 2;
				return buildComboRows().filter(function (row) {
					var eligible = filter.whitelistOnly === true
						? row.whiteCount
						: Math.max(row.count, row.whiteCount);
					if (eligible < minSources) return false;
					if ((filter.providers || []).length > 0) {
						var pool = filter.whitelistOnly === true ? row.whiteMembers : row.members.concat(row.whiteMembers);
						var hitsProvider = pool.some(function (member) { return filter.providers.indexOf(member.provider) >= 0; });
						if (!hitsProvider) return false;
					}
					if (comboAvailability.length > 0) {
						var counts = availabilityCountsOf(rowMembers(row), availability);
						return availabilityMatches(counts);
					}
					return true;
				});
			}

			/** Provider chips shown above the category list. */
			function comboProviderOptions() {
				var rows = buildComboRows();
				var names = [];
				rows.forEach(function (row) {
					row.members.concat(row.whiteMembers).forEach(function (member) {
						if (names.indexOf(member.provider) < 0) names.push(member.provider);
					});
				});
				return names.sort();
			}

			function toggleComboProvider(provider) {
				var next = (comboFilter.providers || []).slice();
				var at = next.indexOf(provider);
				if (at >= 0) next.splice(at, 1);
				else next.push(provider);
				setComboFilter(Object.assign({}, comboFilter, { providers: next }));
			}

			function patchComboFilter(patchValue) {
				setComboFilter(Object.assign({}, comboFilter, patchValue));
			}

			// ------------------------------------------------------------ //
			// availability filter (probe verdicts, shared by both lists)    //
			// ------------------------------------------------------------ //
			var COMBO_AVAILABILITY = [
				{ key: 'available', label: '目前可用', color: C.ok },
				{ key: 'staleOk', label: '上次可用·已过期', color: C.warn },
				{ key: 'failed', label: '目前不可用', color: C.err },
				{ key: 'staleFailed', label: '上次不可用·已过期', color: C.faint },
				{ key: 'unknown', label: '未测', color: C.dim },
			];

			/**
			 * Route verdict bucket by `provider\u0000model`. A verdict older than
			 * PROBE_STALE_MS is stale — and stale-OK is deliberately a different
			 * bucket from stale-failed, because "was usable 20 minutes ago" and
			 * "was already dead 20 minutes ago" mean opposite things when pruning.
			 */
			function probeRouteIndex() {
				var body = results.results;
				var list = body && Array.isArray(body.routes) ? body.routes : [];
				var index = {};
				var now = Date.now();
				list.forEach(function (row) {
					if (!row || typeof row.provider !== 'string' || typeof row.model !== 'string') return;
					var at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
					var fresh = isFinite(at) && now - at <= PROBE_STALE_MS;
					index[row.provider + '\u0000' + row.model] = row.ok === true
						? (fresh ? 'available' : 'staleOk')
						: (fresh ? 'failed' : 'staleFailed');
				});
				return index;
			}

			function availabilityCountsOf(members, index) {
				var counts = { available: 0, staleOk: 0, failed: 0, staleFailed: 0, unknown: 0 };
				(members || []).forEach(function (member) {
					if (!member || typeof member.provider !== 'string' || typeof member.model !== 'string') return;
					var bucket = index[member.provider + '\u0000' + member.model] || 'unknown';
					counts[bucket] += 1;
				});
				return counts;
			}

			function availabilityMatches(counts) {
				if (comboAvailability.length === 0) return true;
				return comboAvailability.some(function (bucket) { return (counts[bucket] || 0) > 0; });
			}

			function toggleAvailabilityBucket(key) {
				// Functional update: two clicks can land before a re-render, and a
				// stale capture would silently re-add the bucket instead of clearing.
				setComboAvailability(function (previous) {
					var next = previous.slice();
					var at = next.indexOf(key);
					if (at >= 0) next.splice(at, 1);
					else next.push(key);
					return next;
				});
			}

			function availabilityBadges(counts) {
				return COMBO_AVAILABILITY
					.filter(function (bucket) { return (counts[bucket.key] || 0) > 0; })
					.map(function (bucket) {
						return h('span', {
							key: bucket.key,
							style: Object.assign({}, S.badge, { fontSize: '11px', color: bucket.color, borderColor: bucket.color }),
						}, bucket.label + ' ' + counts[bucket.key]);
					});
			}

			function absorbCombos(payload) {
				if (!payload || payload.ok !== true) {
					var message = (payload && payload.error) || '未知错误';
					if (comboEndpointMissing(payload)) {
						message = '宿主还没重启：组合功能需要 0.3.0 的宿主代码，重启 DSH 后这里才能用。';
					}
					setComboMsg({ kind: 'error', text: message });
					return null;
				}
				setCombos(comboStateFrom(payload));
				return payload;
			}

			function loadCombos() {
				setCombos(Object.assign({}, combos, { loading: true, error: '' }));
				call('/combos').then(absorbCombos).catch(function (e) {
					setCombos({
						loading: false,
						error: '读取组合失败：' + String(e && e.message ? e.message : e),
						note: '', provider: '', path: '', updatedAt: '', combos: [], categories: [], stats: [], hidden: 0,
					});
				});
			}

			react.useEffect(function () {
				loadCombos();
			}, []);

			function comboCall(body) {
				return call('/combos', 'POST', body);
			}

			function comboStatsFor(id) {
				var list = combos.stats || [];
				for (var index = 0; index < list.length; index += 1) {
					if (list[index].id === id) return list[index];
				}
				return null;
			}

			function pickedComboKeys() {
				return Object.keys(comboPick).filter(function (key) { return comboPick[key] === true; });
			}

			function toggleComboPick(key) {
				var next = Object.assign({}, comboPick);
				if (next[key] === true) delete next[key];
				else next[key] = true;
				setComboPick(next);
			}

			/**
			 * Combos sit next to plain models in the models page, so their display
			 * name carries a prefix. Newer hosts already send it; older ones do not,
			 * hence the client-side guard (the prefix lives in one place per side).
			 */
			function comboDisplayName(name) {
				var text = typeof name === 'string' ? name : '';
				var bare = text.indexOf('⚡ ') === 0 ? text.slice(2) : text;
				return '⚡ ' + bare.trim();
			}

			/** Every route currently authorized for subagents, keyed `provider\u0000model`. */
			function whitelistRouteSet() {				var set = {};
				(allowlist.routes || []).forEach(function (route) {
					if (route && typeof route.provider === 'string' && typeof route.model === 'string') {
						set[route.provider + '\u0000' + route.model] = true;
					}
				});
				return set;
			}

			/** Select every category currently visible under the active filters. */
			function selectAllComboCategories() {
				var rows = filteredComboRows();
				var next = {};
				rows.forEach(function (row) { next[row.key] = true; });
				setComboPick(next);
				var count = rows.length;
				setComboMsg(count === 0
					? { kind: 'error', text: '当前筛选下没有可生成的类别；放宽筛选条件或点「刷新类别」重读宿主模型清单。' }
					: {
						kind: 'ok',
						text: '已勾选筛选后的 ' + count + ' 个类别'
							+ (comboFilter.whitelistOnly === true ? '；生成时成员只取白名单里的路由。' : '；生成时成员取自宿主目录。'),
					});
			}

			/**
			 * "按白名单全选" keeps its promise literally: switch the source filter to
			 * whitelist-only, then select every category the whitelist can form.
			 */
			function selectWhitelistComboCategories() {
				if ((allowlist.routes || []).length === 0) {
					setComboMsg({ kind: 'error', text: '没有读到子智能体白名单（「设置 → 内置插件 → 子智能体」）；请先在那里勾选授权模型。' });
					return;
				}
				setComboFilter(Object.assign({}, comboFilter, { whitelistOnly: true }));
				var rows = filteredComboRows(Object.assign({}, comboFilter, { whitelistOnly: true }));
				var next = {};
				rows.forEach(function (row) { next[row.key] = true; });
				setComboPick(next);
				setComboMsg(rows.length === 0
					? { kind: 'error', text: '白名单里凑不出 2 条以上的同类模型（可在下面打开「包含单来源类别」，或先去子智能体设置里授权更多模型）。' }
					: { kind: 'ok', text: '已按白名单勾选 ' + rows.length + ' 个类别；生成的组合只使用白名单里的成员。' });
			}

			function deleteAllCombos() {
				var total = (combos.combos || []).length;
				if (total === 0) {
					setComboArm(false);
					setComboMsg({ kind: 'error', text: '还没有组合可删。' });
					return;
				}
				if (comboArm !== true) {
					setComboArm(true);
					setComboMsg({ kind: 'error', text: '再点一次「确认删除全部」就会删掉 ' + total + ' 个组合。' });
					return;
				}
				setComboArm(false);
				comboAction({ action: 'delete-all' }, '已删除全部 ' + total + ' 个组合（模型列表里也会一起消失）。');
			}

			function generateCombos() {
				var keys = pickedComboKeys();
				if (keys.length === 0) {
					setComboMsg({ kind: 'error', text: '先勾选要生成的模型类别。' });
					return;
				}
				var rows = buildComboRows();
				var byKey = {};
				rows.forEach(function (row) { byKey[row.key] = row; });
				var requests = [];
				var skipped = [];
				keys.forEach(function (key) {
					var row = byKey[key];
					if (row === undefined) {
						skipped.push(key + '（类别已不存在，先刷新类别）');
						return;
					}
					var members = rowMembers(row);
					if (members.length === 0) {
						skipped.push(key + '（当前筛选下没有成员）');
						return;
					}
					requests.push({ key: key, scope: rowScope(row), members: members });
				});
				if (requests.length === 0) {
					setComboMsg({ kind: 'error', text: '没有可生成的类别：' + skipped.slice(0, 3).join('；') });
					return;
				}
				setComboBusy(true);
				setComboMsg({ kind: '', text: '正在生成 ' + requests.length + ' 个组合…' });
				var failures = skipped.slice();
				var chain = Promise.resolve();
				requests.forEach(function (request) {
					chain = chain.then(function () {
						return comboCall({
							action: 'create',
							key: request.key,
							scope: request.scope,
							members: request.members,
						}).then(function (payload) {
							if (absorbCombos(payload) === null) {
								failures.push(request.key + '（' + ((payload && payload.error) || '失败') + '）');
							}
						});
					});
				});
				chain.catch(function (e) {
					failures.push(String(e && e.message ? e.message : e));
				}).then(function () {
					setComboBusy(false);
					setComboPick({});
					loadCombos();
					setComboMsg(failures.length === 0
						? { kind: 'ok', text: '已生成 ' + requests.length + ' 个组合。它们作为 provider「' + (combos.provider || 'failover-combos') + '」里的模型出现，可在 设置 → 模型 里选中，也可填进候选链或子智能体白名单。' }
						: { kind: 'error', text: '有 ' + failures.length + ' 个没生成：' + failures.slice(0, 3).join('；') });
				});
			}

			function comboAction(body, okText) {
				setComboBusy(true);
				comboCall(body).then(function (payload) {
					var applied = absorbCombos(payload);
					setComboBusy(false);
					setComboArm(false);
					setDeleteArm(null);
					setComboMsg(applied === null
						? { kind: 'error', text: (payload && payload.error) || '操作失败' }
						: { kind: 'ok', text: okText || '已保存' });
				}).catch(function (e) {
					setComboBusy(false);
					setComboMsg({ kind: 'error', text: String(e && e.message ? e.message : e) });
				});
			}

			function deleteCombo(combo) {
				if (deleteArm !== combo.id) {
					setDeleteArm(combo.id);
					setComboMsg({ kind: 'error', text: '再点一次「确认删除」就会删掉组合「' + comboDisplayName(combo.name) + '」。' });
					return;
				}
				setDeleteArm(null);
				comboAction({ action: 'delete', id: combo.id }, '已删除组合「' + comboDisplayName(combo.name) + '」。');
			}

			function toggleCombo(combo) {
				comboAction({ action: 'toggle', id: combo.id, enabled: combo.enabled === false },
					combo.enabled === false ? '已启用「' + combo.name + '」。' : '已停用「' + combo.name + '」（模型仍会列出，但不会接生成）。');
			}

			function rebuildCombo(combo) {
				comboAction({ action: 'rebuild', id: combo.id, key: combo.key }, '已按最新的宿主机型清单刷新「' + combo.name + '」的成员。');
			}

			function addComboToCandidates(combo) {
				var route = (combos.provider || 'failover-combos') + '/' + combo.id;
				var text = String((draft && draft.candidatesText) || '');
				var lines = text.split(/\r?\n/).map(function (line) { return line.trim(); });
				if (lines.indexOf(route) >= 0) {
					setComboMsg({ kind: 'ok', text: '候选链里已经有 ' + route + '。' });
					return;
				}
				patch({ candidatesText: text.length > 0 ? text.replace(/\s+$/, '') + '\n' + route : route });
				setComboMsg({ kind: 'ok', text: '已把 ' + route + ' 加到候选链末尾，点页面顶部的「保存」后才写盘。' });
			}


			if (!draft) {
				return h('div', { style: S.wrap },
					h('div', { style: S.card },
						h('div', { style: { color: status.kind === 'error' ? C.err : C.dim } },
							status.kind === 'error' ? status.text : '正在读取插件状态…')));
			}

			var journal = (state && state.journal) || null;
			var events = (journal && Array.isArray(journal.events)) ? journal.events.slice().reverse() : [];
			var allow = state && state.allowlist;
			var selectedProviders = checkedProviders();
			var selectedTotal = providersTargetCount();
			var selectedBatches = selectedTotal > PROBE_LIMIT ? Math.ceil(selectedTotal / PROBE_LIMIT) : 1;
			// Combos: categories are merged from the Host payload + the model catalog +
			// the subagent whitelist, then filtered by the three controls below.
			var comboRows = buildComboRows();
			var visibleComboRows = filteredComboRows();
			var comboProviders = comboProviderOptions();
			var comboAvailabilityIndex = probeRouteIndex();
			var visibleCombos = (combos.combos || []).filter(function (combo) {
				if (comboAvailability.length === 0) return true;
				return availabilityMatches(availabilityCountsOf(combo.members, comboAvailabilityIndex));
			});
			var comboCount = (combos.combos || []).length;
			var comboQueryText = String(comboQuery || '').trim().toLowerCase();
			var searchedCombos = comboQueryText === ''
				? visibleCombos
				: visibleCombos.filter(function (combo) {
					var haystack = [combo.name, combo.id, combo.key]
						.concat((combo.members || []).map(function (member) { return member.provider + '/' + member.model; }))
						.join(' ').toLowerCase();
					return haystack.indexOf(comboQueryText) >= 0;
				});
			var shownCombos = comboOpen === true ? searchedCombos.slice(0, comboLimit) : searchedCombos;
			var comboEnabledCount = (combos.combos || []).filter(function (combo) { return combo.enabled !== false; }).length;
			var availabilityRows = results.results && Array.isArray(results.results.routes) ? results.results.routes : [];
			var availabilityOkCount = availabilityRows.filter(function (row) { return row.ok === true; }).length;
			var availabilityTestedAt = (results.results && results.results.testedAt) || '';
			var availabilityStale = availabilityTestedAt !== '' && (Date.now() - Date.parse(availabilityTestedAt) > PROBE_STALE_MS);
			var candidateCount = String((draft && draft.candidatesText) || '').split(/\r?\n/).filter(function (line) { return line.trim().length > 0; }).length;
			/** Inactive tabs stay mounted so their state and scroll position survive. */
			function cardStyle(key) {
				return tab === key ? S.card : Object.assign({}, S.card, { display: 'none' });
			}
			function cardProps(key) {
				return {
					id: 'quota-failover-panel-' + key,
					style: cardStyle(key),
					role: 'tabpanel',
					'aria-labelledby': 'quota-failover-tab-' + key,
					'aria-hidden': tab !== key,
				};
			}
			function tabLabel(item) {
				if (item.key === 'combos' && comboCount > 0) return item.label + '（' + comboCount + '）';
				if (item.key === 'events' && events.length > 0) return item.label + '（' + events.length + '）';
				if (item.key === 'availability' && availabilityRows.length > 0) return item.label + '（' + availabilityOkCount + '/' + availabilityRows.length + '）';
				return item.label;
			}
			function summaryChip(label, value) {
				return h('div', { style: S.summary },
					h('div', { style: S.summaryLabel }, label),
					h('div', { style: S.summaryValue }, value));
			}

			var modeOption = function (value, title, sub) {
				var on = draft.mode === value;
				return h('div', {
					style: Object.assign({}, S.opt, on ? S.optOn : null),
					onClick: function () { patch({ mode: value }); },
					role: 'button',
				},
					h('span', { style: { color: on ? C.accent : C.faint, lineHeight: '18px' } }, on ? '●' : '○'),
					h('div', null,
						h('div', { style: { fontWeight: on ? 600 : 400 } }, title),
						h('div', { style: S.hint }, sub)));
			};

			return h('div', { style: S.wrap },

				// ---- tabs ---------------------------------------------------
				h('div', { style: S.tabs, role: 'tablist' },
					TABS.map(function (item) {
						var on = item.key === tab;
						return h('button', {
							key: item.key,
							id: 'quota-failover-tab-' + item.key,
							role: 'tab',
							'aria-selected': on,
							'aria-controls': 'quota-failover-panel-' + item.key,
							style: on ? S.tabOn : S.tab,
							onClick: function () { setTab(item.key); },
						}, tabLabel(item));
					})),

				// ---- save bar (visible on every tab) ------------------------
				h('div', { style: S.saveBar },
					h('button', { style: busy ? Object.assign({}, S.btnPrimary, S.btnDisabled) : S.btnPrimary, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
					h('button', { style: resetArm ? Object.assign({}, S.btnDangerArm, busy ? S.btnDisabled : {}) : S.btn, disabled: busy, onClick: requestReset }, resetArm ? '确认恢复默认' : '恢复默认'),
					status.text
						? h('span', { style: { color: status.kind === 'error' ? C.err : status.kind === 'ok' ? C.ok : C.dim, fontSize: '12.5px', flex: '1 1 240px', minWidth: 0 } }, status.text)
						: h('span', { style: Object.assign({}, S.hint, { marginTop: 0, flex: '1 1 240px' }) }, '改完设置后点「保存」；保存立即生效。'),
					h('span', { style: Object.assign({}, S.hint, { marginTop: 0, marginLeft: 'auto' }) }, '保存只影响插件行为，不影响 agent 自己的模型选择。')),

				// ---- status -------------------------------------------------
				h('div', cardProps('status'),
					h('div', { style: S.cardTitle }, '状态'),
					h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
						h('span', { style: Object.assign({}, S.badge, { color: draft.enabled ? C.ok : C.faint, borderColor: draft.enabled ? C.ok : C.line }) },
							draft.enabled ? '已启用' : '已停用'),
						h('span', { style: S.badge }, '模式：' + (draft.mode === 'auto' ? '失败后自动切换' : '只通知 agent')),
						h('span', { style: S.badge }, 'v' + (state.version || '?'))),
					h('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) },
						(state.paths ? '配置：' + state.paths.config : '')
						+ (journal ? ' · 已接管：' + new Date(journal.armedAt).toLocaleString() + ' · pid ' + journal.pid : '')),
					h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' } },
						summaryChip('候选路由', candidateCount + ' 条'),
						summaryChip('子智能体白名单', (allowlist.routes || []).length + ' 条 / ' + (allowlist.providers || []).length + ' 个 provider'),
						summaryChip('模型组合', comboCount + ' 个' + (comboCount > 0 ? '（启用 ' + comboEnabledCount + '）' : '')),
						summaryChip('可用性', availabilityRows.length > 0
							? (availabilityOkCount + ' 可用 / ' + availabilityRows.length + ' 条'
								+ (availabilityTestedAt !== '' ? ' · 测于 ' + new Date(availabilityTestedAt).toLocaleTimeString() : '')
								+ (availabilityStale ? ' · 已过期' : ''))
							: '还没测'),
						summaryChip('最近事件', events.length + ' 条'))),

				// ---- behaviour ----------------------------------------------
				h('div', cardProps('failure'),
					h('div', { style: S.cardTitle }, '失败后怎么处理'),
					h('label', { style: S.row },
						h('div', { style: S.rowLabel }, '总开关'),
						h('div', { style: S.rowBody },
							h('input', { type: 'checkbox', checked: !!draft.enabled, onChange: function (e) { patch({ enabled: e.target.checked }); } }),
							h('span', { style: { marginLeft: '8px' } }, '响应失败事件（关闭后插件完全静默）'))),
					h('div', { style: S.row },
						h('div', { style: S.rowLabel }, '处理方式'),
						h('div', { style: S.rowBody },
							modeOption('notify', '只通知 agent（默认，推荐）',
								'不动 agent 选好的模型。失败后把情况告诉失败的子智能体，也告诉派发它的父 agent，由做选择的那一方自己决定换不换模型。'),
							modeOption('auto', '失败后自动切换路由',
								'在候选路由里挑下一条重试，调用方看不到中断。会覆盖 agent 自己的模型选择，而且不知道任务需要哪种能力（视频/图像/长上下文），可能换到缺能力的模型。'))),
					h('label', { style: S.row },
						h('div', { style: S.rowLabel }, '把情况告诉 agent'),
						h('div', { style: S.rowBody },
							h('input', { type: 'checkbox', checked: !!draft.notify, onChange: function (e) { patch({ notify: e.target.checked }); } }),
							h('span', { style: { marginLeft: '8px' } }, '写进失败子智能体的会话历史，并告知派发它的父 agent（不唤醒新一轮，因此不会死循环）'),
							h('div', { style: S.hint }, '给失败方的说明：哪条路由、什么错误码、原始信息、本轮已试过哪些、可用候选有哪些、下一步该怎么做。'),
							h('div', { style: S.hint }, '给父 agent（做模型选择的那一方）的说明额外要求它先判断任务是否依赖原模型的特有能力，再决定换哪个模型或改派任务。'))),
					h('div', { style: S.row },
						h('div', { style: S.rowLabel }, '自动切换的候选路由'),
						h('div', { style: S.rowBody },
							h('textarea', {
								style: Object.assign({}, S.area, { minHeight: '112px' }),
								value: draft.candidatesText,
								spellCheck: false,
								onChange: function (e) { patch({ candidatesText: e.target.value }); },
							}),
							h('div', { style: S.hint }, '每行一条 `provider/model`，按顺序尝试。只在「自动切换」模式下使用。'))),
					h('div', { style: S.row },
						h('div', { style: S.rowLabel }, '测试这些路由'),
						h('div', { style: S.rowBody },
							h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
								h('button', { style: S.btn, disabled: probe.running, onClick: runProbe }, probe.running ? '测试中…' : '测试候选路由'),
								probe.text ? h('span', { style: { color: C.dim, fontSize: '12.5px' } }, probe.text) : null),
							h('div', { style: S.hint }, '对上面每条候选路由真实发一次极短的请求，看它到底能不能用。会消耗少量额度。'))),
					h('div', { style: S.row },
						h('div', { style: S.rowLabel }, '遵守子智能体模型白名单'),
						h('div', { style: S.rowBody },
							h('input', { type: 'checkbox', checked: !!draft.respectAllowlist, onChange: function (e) { patch({ respectAllowlist: e.target.checked }); } }),
							h('span', { style: { marginLeft: '8px' } }, '自动切换只在设置里授权的子智能体模型中挑'),
							h('div', { style: S.hint },
								allow === undefined
									? '未读到 subagent-model-selection-settings，白名单不生效。'
									: '白名单：' + (allow.enabled ? '已开启' : '已关闭') + '，' + allow.total + ' 条 / ' + allow.providers.length + ' 个 provider'
										+ '（' + allow.providers.slice(0, 6).map(function (p) { return p.id + ' ' + p.count; }).join('、') + '…）'))),
					h('div', { style: S.row },
						h('div', { style: S.rowLabel }, '粘滞时间（分钟）'),
						h('div', { style: S.rowBody },
							h('input', {
								type: 'number', min: 0, step: 1, style: Object.assign({}, S.input, { width: '120px' }),
								value: draft.stickyMinutes,
								onChange: function (e) { patch({ stickyMinutes: e.target.value }); },
							}),
							h('div', { style: S.hint }, '自动切换后，这段时间内该会话直接使用新路由；0 表示每轮都重新尝试。'))),
					h('label', { style: S.row },
						h('div', { style: S.rowLabel }, '记录事件'),
						h('div', { style: S.rowBody },
							h('input', { type: 'checkbox', checked: !!draft.journal, onChange: function (e) { patch({ journal: e.target.checked }); } }),
							h('span', { style: { marginLeft: '8px' } }, '写 $DSH_HOME/quota-failover.json（最多 64 条）')))),

				// ---- combos --------------------------------------------------
				h('div', cardProps('combos'),
					h('div', { style: S.cardTitle }, '模型组合（跨 provider 自动降级）'),
					h('div', { style: S.hint },
						'把同一个模型在不同 provider 上的实现编成一条路由：' + (combos.provider || 'failover-combos') + '/combo:<类别>。'
						+ '一次生成先试第一个成员；额度墙、账号不支持该模型、临时故障会静默换下一个成员。正文一旦开始输出就不再回退 —— 已吐出的字不会撤回。'),
					h('div', { style: Object.assign({}, S.hint, { marginTop: '4px' }) },
						'组合生成后作为一种普通模型出现在「设置 → 模型」里（provider 是「额度转移 Combo」），也可以填进上面的候选链或子智能体白名单。它只管一次生成的内部降级，不改变 agent 自己选模型的逻辑。'),
					combos.loading ? h('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) }, '正在读取组合…') : null,
					combos.error ? h('div', { style: { color: C.warn, fontSize: '12.5px', marginTop: '8px' } }, combos.error) : null,
					combos.note ? h('div', { style: Object.assign({}, S.hint, { marginTop: '6px' }) }, combos.note) : null,
					// One availability control for both lists: categories to generate from
					// and the combos already generated. Default state is "no filter".
					h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' } },
						h('span', { style: S.hint }, '可用性筛选（两处共用）：'),
						COMBO_AVAILABILITY.map(function (bucket) {
							var on = comboAvailability.indexOf(bucket.key) >= 0;
							return h('button', {
								key: bucket.key,
								style: Object.assign({}, S.btn, on ? { borderColor: C.accent, color: C.accent } : {}),
								onClick: function () { toggleAvailabilityBucket(bucket.key); },
							}, bucket.label);
						}),
						comboAvailability.length > 0
							? h('span', { style: S.hint }, '只显示勾选状态；再点一次取消。')
							: h('span', { style: S.hint }, '默认不筛。状态取自「模型路由可用性」的测试结果，超过 15 分钟算过期；没测过的归为「未测」。')),
					combos.combos.length > 0
						? h('div', { style: Object.assign({}, S.section, { marginTop: '12px' }) },
							h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
								h('span', { style: { fontWeight: 600 } }, '已生成的组合（' + visibleCombos.length + (visibleCombos.length === combos.combos.length ? '' : ' / ' + combos.combos.length) + '）'),
								h('button', { style: S.btn, onClick: function () { setComboOpen(!comboOpen); } }, comboOpen ? '收起' : '展开'),
								h('input', {
									type: 'search',
									placeholder: '搜索组合名 / 成员…',
									value: comboQuery,
									style: S.search,
									onChange: function (event) { setComboQuery(event.target.value); setComboLimit(50); },
								}),
								h('button', { style: Object.assign({}, S.btnDanger, comboArm ? { background: 'rgba(228,103,107,.16)' } : {}), disabled: comboBusy, onClick: deleteAllCombos }, comboArm ? '确认删除全部（' + combos.combos.length + '）' : '删除全部'),
								comboOpen ? null : h('span', { style: S.hint }, '默认折叠；点「展开」查看成员、停用、刷新或删除。')),
							comboOpen ? (searchedCombos.length === 0
								? h('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) },
									comboQueryText === ''
										? '当前可用性筛选下没有组合：调整上方的可用性筛选，或关掉筛选。'
										: '没有匹配「' + comboQuery + '」的组合：换个关键字，或清空搜索框。')
								: shownCombos.map(function (combo) {
								var enabled = combo.enabled !== false;
								var stat = comboStatsFor(combo.id);
								var availBadges = availabilityBadges(availabilityCountsOf(combo.members, comboAvailabilityIndex));
								return h('div', { key: combo.id, style: { border: '1px solid ' + C.line, borderRadius: '8px', padding: '9px 11px', marginBottom: '8px' } },
									h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
										h('span', { style: { fontWeight: 600 } }, comboDisplayName(combo.name)),
										h('span', { style: S.badge }, combo.strategy === 'round-robin' ? '轮转 · 粘滞 ' + combo.stickyLimit : '顺序降级'),
										h('span', { style: S.badge }, combo.members.length + ' 个成员'),
										h('span', { style: Object.assign({}, S.badge, { color: enabled ? C.ok : C.faint, borderColor: enabled ? C.ok : C.line }) }, enabled ? '启用中' : '已停用'),
										combo.scope === 'whitelist'
											? h('span', { style: Object.assign({}, S.badge, { color: C.accent, borderColor: C.accent }) }, '仅白名单')
											: null),
									availBadges.length > 0
										? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' } }, availBadges)
										: null,
									h('div', { style: Object.assign({}, S.hint, { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', marginTop: '3px' }) },
										(combos.provider || 'failover-combos') + '/' + combo.id),
									h('div', { style: Object.assign({}, S.hint, { marginTop: '3px' }) },
										combo.members.map(function (member) { return member.provider + '/' + member.model; }).join(' · ')),
									stat && stat.lastOutcome
										? h('div', { style: S.hint },
											'最近：' + (stat.lastOutcome === 'ok' ? '正常' : stat.lastOutcome)
											+ (stat.lastMember ? ' · ' + stat.lastMember : '')
											+ (stat.switches ? ' · 已切换 ' + stat.switches + ' 次' : '')
											+ (stat.lastRunAt ? ' · ' + new Date(stat.lastRunAt).toLocaleString() : ''))
										: null,
									h('div', { style: { display: 'flex', gap: '8px', marginTop: '7px', flexWrap: 'wrap' } },
										h('button', { style: S.btn, disabled: comboBusy, onClick: function () { toggleCombo(combo); } }, enabled ? '停用' : '启用'),
										h('button', { style: S.btn, disabled: comboBusy, onClick: function () { rebuildCombo(combo); } }, '刷新成员'),
										h('button', { style: S.btn, disabled: comboBusy, onClick: function () { addComboToCandidates(combo); } }, '加入候选链'),
										h('button', {
											style: deleteArm === combo.id ? Object.assign({}, S.btnDangerArm, comboBusy ? S.btnDisabled : {}) : S.btnDanger,
											disabled: comboBusy,
											onClick: function () { deleteCombo(combo); },
										}, deleteArm === combo.id ? '确认删除' : '删除')));
							}).concat(searchedCombos.length > shownCombos.length
								? [h('div', { key: 'combo-more', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px', flexWrap: 'wrap' } },
									h('span', { style: S.hint }, '显示前 ' + shownCombos.length + ' / ' + searchedCombos.length + ' 个组合'),
									h('button', { style: S.btn, onClick: function () { setComboLimit(Number.MAX_SAFE_INTEGER); } }, '显示全部 ' + searchedCombos.length + ' 个'))]
								: [])) : null)
						: (combos.loading || combos.error
							? null
							: h('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) }, '还没有组合。下面挑几个模型类别就能生成。')),
					combos.categories.length > 0
						? h('div', { style: Object.assign({}, S.section, { marginTop: '12px' }) },
							h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
								h('span', { style: { fontWeight: 600 } }, '可以生成的模型类别'),
								h('span', { style: S.hint }, '筛选后 ' + visibleComboRows.length + ' / ' + comboRows.length + ' 个类别'
									+ (combos.hidden > 0 && comboFilter.singles !== true ? '（宿主隐去 ' + combos.hidden + ' 个单来源类别）' : '')
									+ (comboAvailability.length > 0 ? '（可用性筛选已启用）' : '')),
								h('button', { style: visibleComboRows.length === 0 ? Object.assign({}, S.btn, S.btnDisabled) : S.btn, disabled: visibleComboRows.length === 0, onClick: selectAllComboCategories }, '全选'),
								h('button', { style: (allowlist.routes || []).length === 0 ? Object.assign({}, S.btn, S.btnDisabled) : S.btn, disabled: (allowlist.routes || []).length === 0, onClick: selectWhitelistComboCategories }, '按白名单全选'),
								h('button', { style: S.btn, onClick: function () { setComboPick({}); setComboMsg({ kind: '', text: '已清空勾选。' }); } }, '全不选')),
							h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center', marginTop: '9px' } },
								h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer' } },
									h('input', {
										type: 'checkbox',
										checked: comboFilter.whitelistOnly === true,
										onChange: function (event) { patchComboFilter({ whitelistOnly: event.target.checked }); },
									}),
									h('span', null, '只使用白名单来源'),
									h('span', { style: S.hint }, '（默认开启；不在白名单里的模型不会进入 combo）')),
								h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer' } },
									h('input', {
										type: 'checkbox',
										checked: comboFilter.singles === true,
										onChange: function (event) { patchComboFilter({ singles: event.target.checked }); },
									}),
									h('span', null, '显示单来源类别'),
									h('span', { style: S.hint }, '（默认关闭；只有一个 provider 的类别也能生成）'))),
							comboProviders.length > 0
								? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginTop: '8px' } },
									h('span', { style: S.hint }, '来源 provider：'),
									h('button', {
										style: Object.assign({}, S.btn, (comboFilter.providers || []).length === 0 ? { borderColor: C.accent, color: C.accent } : {}),
										onClick: function () { patchComboFilter({ providers: [] }); },
									}, '全部'),
									comboProviders.map(function (provider) {
										var on = (comboFilter.providers || []).indexOf(provider) >= 0;
										return h('button', {
											key: provider,
											style: Object.assign({}, S.btn, on ? { borderColor: C.accent, color: C.accent } : {}),
											onClick: function () { toggleComboProvider(provider); },
										}, provider);
									}))
								: null,
							visibleComboRows.length === 0
								? h('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) }, '当前筛选下没有类别：把「只使用白名单来源」关掉、打开「显示单来源类别」、换一个 provider，或取消可用性筛选。')
								: h('div', { style: { maxHeight: '280px', overflow: 'auto', marginTop: '8px' } },
									visibleComboRows.map(function (row) {
										var picked = comboPick[row.key] === true;
										var effective = rowMembers(row);
										var availBadges = availabilityBadges(availabilityCountsOf(effective, comboAvailabilityIndex));
										var memberNames = [];
										var seenProvider = {};
										effective.forEach(function (member) {
											if (seenProvider[member.provider]) return;
											seenProvider[member.provider] = true;
											memberNames.push(member.provider);
										});
										var scope = rowScope(row);
										return h('label', { key: row.key, style: { display: 'flex', gap: '9px', alignItems: 'flex-start', padding: '6px 0', cursor: 'pointer' } },
											h('input', { type: 'checkbox', checked: picked, onChange: function () { toggleComboPick(row.key); }, style: { marginTop: '2px' } }),
											h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
												h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } },
													h('span', { style: { fontWeight: picked ? 600 : 400 } }, row.name),
													h('span', { style: Object.assign({}, S.badge, { fontSize: '11px' }) }, row.key),
													availBadges.length > 0
														? h('span', { style: { display: 'inline-flex', gap: '6px', flexWrap: 'wrap' } }, availBadges)
														: null,
													row.selected
														? h('span', { style: Object.assign({}, S.badge, { color: row.enabled === false ? C.faint : C.ok, borderColor: row.enabled === false ? C.line : C.ok }) },
															row.enabled === false ? '已有组合（停用中）' : '已有组合')
														: null),
												h('div', { style: Object.assign({}, S.hint, { marginTop: '1px' }) },
													(scope === 'whitelist'
														? '白名单 ' + row.whiteCount + ' 条' + (row.count === 0 ? '（仅白名单）' : '')
														: '目录 ' + row.count + ' 条 / ' + row.providers + ' provider' + (row.whiteCount > 0 ? ' · 白名单 ' + row.whiteCount + ' 条' : ''))
													+ ' · 本次成员 ' + effective.length + ' 条'
													+ (memberNames.length > 0 ? '（' + memberNames.join('、') + '）' : ''))));
									})),
							h('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) },
								'本次生成：成员' + (comboFilter.whitelistOnly === true ? '只取子智能体白名单里的路由' : '取自宿主目录里列出的路由')
								+ ((comboFilter.providers || []).length > 0 ? '，且只取所选 provider（' + comboFilter.providers.join('、') + '）' : '') + '。'),
							h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' } },
								h('button', {
									style: (comboBusy || pickedComboKeys().length === 0) ? Object.assign({}, S.btnPrimary, S.btnDisabled) : S.btnPrimary,
									disabled: comboBusy || pickedComboKeys().length === 0,
									onClick: generateCombos,
								}, comboBusy ? '处理中…' : '按勾选的类别生成组合（' + pickedComboKeys().length + '）'),
								h('button', { style: comboBusy ? Object.assign({}, S.btn, S.btnDisabled) : S.btn, disabled: comboBusy, onClick: loadCombos }, '刷新类别（重读宿主模型清单）')))
						: null,
					comboMsg.text
						? h('div', { style: { color: comboMsg.kind === 'error' ? C.err : comboMsg.kind === 'ok' ? C.ok : C.dim, fontSize: '12.5px', marginTop: '8px' } }, comboMsg.text)
						: null,
					combos.updatedAt
						? h('div', { style: Object.assign({}, S.hint, { marginTop: '8px' }) },
							'组合配置：' + combos.path + '（更新于 ' + new Date(combos.updatedAt).toLocaleString() + '）')
						: null),

				// ---- availability -------------------------------------------
				h('div', cardProps('availability'),
					h('div', { style: S.cardTitle }, '模型路由可用性'),
					h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
						results.loading
							? h('span', { style: S.badge }, '正在读取测试结果…')
							: (results.results && results.results.testedAt
								? h('span', { style: S.badge }, '最近一次测试：' + new Date(results.results.testedAt).toLocaleString())
								: h('span', { style: S.badge }, '还没有测试结果')),
						results.results && Array.isArray(results.results.routes)
							? h('span', { style: S.badge }, results.results.routes.filter(function (row) { return row.ok === true; }).length + ' 可用 / ' + results.results.routes.length + ' 条已测')
							: null,
						results.results && results.results.testedAt && (Date.now() - Date.parse(results.results.testedAt) > PROBE_STALE_MS)
							? h('span', { style: Object.assign({}, S.badge, { color: C.warn, borderColor: C.warn }) }, '结果已过期，可能已变化，建议重测')
							: null,
						results.results && results.results.observedAt
							? h('span', { style: S.hint }, '运行中最近观测：' + new Date(results.results.observedAt).toLocaleString())
							: null,
						h('span', { style: S.hint }, '结果会保存到 $DSH_HOME/quota-failover-probe.json，agent 也能通过工具 route_availability 读到同一份。')),
					h('div', { style: Object.assign({}, S.hint, { marginTop: '6px' }) },
						'按 provider 勾选下一轮要测的范围。默认勾选的是「设置 → 内置插件 → 子智能体」里授权的白名单 —— 只测已经授权给 agent 的路由。每条路由真实发一次极短请求（最多等 15 秒），会消耗少量额度。'
						+ '结果是快照：超过 15 分钟会标「已过期」；运行中真实请求失败也会自动补一条「运行时观测」，需要更新可以按 provider 点「重测」。'),
					allowlist.loading
						? h('div', { style: S.hint }, '正在读取子智能体白名单…')
						: h('div', { style: S.hint },
							allowlist.total > 0
								? '子智能体授权模型：' + allowlist.total + ' 条 / ' + allowlist.providers.length + ' 个 provider（读自「设置 → 内置插件 → 子智能体」；开关' + (allowlist.enabled ? '已开启' : '已关闭') + '）'
								: (allowlist.note || '没有读到子智能体白名单，默认勾选全部可路由 provider')),
					h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px', alignItems: 'center' } },
						h('button', { style: S.btn, onClick: function () { checkWhitelistProviders(); } }, '仅白名单'),
						h('button', { style: S.btn, onClick: function () { checkAllProviders(true); } }, '全选'),
						h('button', { style: S.btn, onClick: function () { checkAllProviders(false); } }, '全不选'),
						h('span', { style: S.hint }, '已选 ' + selectedProviders.length + ' 个 provider · ' + selectedTotal + ' 条路由')),
					h('div', {
						style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '4px 16px', marginTop: '8px', maxHeight: '230px', overflow: 'auto' },
					}, providerRows().map(function (row) {
						var on = scope.checked[row.provider] === true;
						return h('label', { key: row.provider, style: { display: 'flex', gap: '8px', alignItems: 'baseline', cursor: 'pointer', padding: '3px 0' } },
							h('input', { type: 'checkbox', checked: on, onChange: function () { toggleProvider(row.provider); } }),
							h('span', { style: { fontWeight: on ? 600 : 400, wordBreak: 'break-all' } }, row.provider),
							h('span', { style: S.hint },
								'白名单 ' + (row.whitelist > 0 ? row.whitelist : '—')
								+ ' · 目录 ' + (row.inventory > 0 ? row.inventory : '—')
								+ (row.tested > 0 ? ' · 已测 ' + row.tested : '')));
					})),
					h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' } },
						h('button', { style: S.btnPrimary, disabled: probe.running || selectedProviders.length === 0, onClick: runProbeSelected },
							probe.running
								? '测试中…'
								: '测试选中的 ' + selectedTotal + ' 条路由' + (selectedBatches > 1 ? '（自动分 ' + selectedBatches + ' 批）' : '')),
						h('button', { style: S.btn, disabled: probe.running || inventory.loading || inventory.total === 0, onClick: runProbeAll },
							'测试全部 ' + (inventory.total || 0) + ' 条可路由模型'),
						probe.text ? h('span', { style: { color: C.dim, fontSize: '12.5px' } }, probe.text) : null),
					selectedBatches > 1
						? h('div', { style: Object.assign({}, S.hint, { marginTop: '6px' }) },
							'超过 ' + PROBE_LIMIT + ' 条会自动分批连续测完：每批一个宿主作业，结果按路由合并保存，不需要手动减少勾选。')
						: null,
					inventory.note ? h('div', { style: S.hint }, inventory.note) : null,
					resultsByProvider().length > 0
						? h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' } },
							h('button', { style: S.btn, disabled: probe.running, onClick: fillCandidates }, '把可用路由填入候选'),
							h('span', { style: S.hint }, '只填入结果为 ✓ 的路由，随后点页面顶部的「保存」才写盘。'))
						: null,
					resultsByProvider().length === 0
						? h('div', { style: Object.assign({}, S.hint, { marginTop: '12px' }) },
							'还没有结果。测试完成后这里会按 provider 分组列出每条路由的可用性、耗时与失败原因，并保留到最后一次测试时间。')
						: h('div', { style: Object.assign({}, S.scroll, { marginTop: '14px' }) },
							resultsByProvider().map(function (group) {
								return h('div', { key: group.provider, style: { marginBottom: '12px' } },
									h('div', {
										style: Object.assign({}, S.groupHeader, {
											marginTop: 0,
											marginBottom: '4px',
											position: 'sticky',
											top: 0,
											zIndex: 1,
											background: C.panel,
										}),
									},
										h('span', { style: { fontWeight: 600, wordBreak: 'break-all' } }, group.provider),
										h('span', { style: S.badge }, group.rows.length + ' 条 · ' + group.ok + ' 可用'),
										group.lastAt ? h('span', { style: S.hint }, '最后更新：' + new Date(group.lastAt).toLocaleString()) : null,
										group.stale
											? h('span', { style: Object.assign({}, S.badge, { color: C.warn, borderColor: C.warn }) }, '已过期')
											: null,
										group.runtime > 0
											? h('span', { style: S.badge }, group.runtime + ' 条运行时观测')
											: null,
										h('button', {
											style: Object.assign({}, S.btn, { marginLeft: 'auto' }),
											disabled: probe.running,
											onClick: function () { probeProvider(group.provider); },
										}, probe.running ? '测试中…' : '重测')),
									h('table', { style: S.table },
										h('tbody', null, group.rows.map(function (row, index) {
											var ok = row.ok === true;
											var detail = ok
												? (row.sample ? '返回：' + row.sample : (row.finish ? '完成（' + row.finish + '）' : '可用'))
												: ((KIND_LABEL[row.kind] || row.kind || '') + (row.code ? ' · ' + row.code : '') + (row.message ? ' · ' + String(row.message).replace(/\s+/g, ' ').slice(0, 160) : ''));
											if (row.source === 'runtime') detail = '运行时观测 · ' + detail;
											return h('tr', { key: group.provider + '/' + row.model + '/' + index },
												h('td', { style: Object.assign({}, S.td, { width: '240px', wordBreak: 'break-all' }) }, row.model),
												h('td', { style: Object.assign({}, S.td, { color: ok ? C.ok : C.err, whiteSpace: 'nowrap', width: '80px' }) }, ok ? '✓ 可用' : '✗ 不可用'),
												h('td', { style: Object.assign({}, S.td, { color: C.dim, whiteSpace: 'nowrap', width: '70px' }) }, (row.ms || 0) + 'ms'),
												h('td', { style: Object.assign({}, S.td, { color: C.dim }) }, detail));
										}))));
							}))),

				// ---- events -------------------------------------------------
				h('div', cardProps('events'),
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
						h('div', { style: Object.assign({}, S.cardTitle, { marginBottom: 0 }) }, '最近事件（' + events.length + '）'),
						h('button', {
							style: Object.assign({}, S.btnSm, events.length === 0 ? S.btnDisabled : null),
							disabled: events.length === 0,
							onClick: clearEvents,
						}, '清空事件')),
					events.length === 0
						? h('div', { style: { color: C.faint } }, '还没有记录。插件工作正常时，这里会安静得像什么都没发生 —— 这恰恰是正常的。')
						: h('div', { style: S.scroll },
							h('table', { style: S.table },
							h('thead', null, h('tr', null,
								h('th', { style: S.th }, '时间'),
								h('th', { style: S.th }, '类型'),
								h('th', { style: S.th }, '路由'),
								h('th', { style: S.th }, '原因'))),
							h('tbody', null, events.map(function (ev, index) {
								var kindColor = ev.kind === 'failover' ? C.warn : ev.kind === 'notify' ? C.accent : ev.kind === 'exhausted' ? C.err : ev.kind === 'probe' ? (ev.ok ? C.ok : C.err) : C.dim;
								var route = ev.route ? ev.route.provider + '/' + ev.route.model : ev.from ? (ev.from.provider + '/' + (ev.from.model || '?')) + ' → ' + (ev.to ? ev.to.provider + '/' + ev.to.model : '?') : '';
								return h('tr', { key: String(index) },
									h('td', { style: S.td }, new Date(ev.at).toLocaleTimeString()),
									h('td', { style: Object.assign({}, S.td, { color: kindColor, whiteSpace: 'nowrap' }) }, ev.kind),
									h('td', { style: S.td }, route),
									h('td', { style: Object.assign({}, S.td, { color: C.dim }) }, ev.reason || ev.code || ''));
							}))))),

				// ---- footer -------------------------------------------------
				h('div', { style: { color: C.faint, fontSize: '12px' } },
					'路由层面的额度墙（QUOTA / ACCOUNT_QUOTA / 死掉的凭据 / 账号不支持该模型）对 agent 循环是终态，内置 llm-retry 故意不碰它。'
					+ '本插件只接管这一类失败，不改变 agent 对子智能体模型的选择。'));
		}

		// `remote.session` is a generated Remote namespace, declared explicitly because the
		// Client exposes Remote namespaces as individual injectable ids (same shape as the
		// shipped settings/model-directory plugins).
		var inject = ['slots', 'remote', 'remote.session', 'configForms'];

		// Captured so the probe helpers can reach Host RPCs (`ctx.remote.session.modelCatalog`)
		// without threading the context through every component.
		var pluginCtx = null;

		function apply(ctx) {
			pluginCtx = ctx;
			ctx.slots.inject('settings.section', function () {
				return ctx.slots.register(
					{ name: 'settings.section', id: 'dsh-quota-failover', order: 60, label: '额度转移' },
					Panel);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
