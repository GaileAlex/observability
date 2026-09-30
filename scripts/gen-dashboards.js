// Generates the Grafana dashboards: node scripts/gen-dashboards.js -> grafana/dashboards/*.json
// Grafana picks the changed files up within 30 s (grafana/provisioning/dashboards/dashboards.yml)
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || path.join(__dirname, '..', 'grafana', 'dashboards');
const PROM = { type: 'prometheus', uid: 'prometheus' };
const LOKI = { type: 'loki', uid: 'loki' };

// validated categorical slots (dark) and status colors of the dataviz reference palette
const SLOT = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const STATUS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b' };

let nextId = 1;

const prom = (expr, legendFormat, extra = {}) => ({ datasource: PROM, expr, legendFormat, range: true, ...extra });
const promInstant = (expr, refId) => ({ datasource: PROM, expr, refId, instant: true, range: false, format: 'table' });
const loki = (expr, legendFormat, extra = {}) => ({ datasource: LOKI, expr, legendFormat, queryType: 'range', ...extra });

function withRefIds(targets) {
    return targets.map((t, i) => ({ refId: t.refId || String.fromCharCode(65 + i), ...t }));
}

// fixed color (and optional display name) of one series: the color follows the entity, not its rank
function seriesOverride(name, color, displayName) {
    const properties = [{ id: 'color', value: { mode: 'fixed', fixedColor: color } }];
    if (displayName) properties.push({ id: 'displayName', value: displayName });
    return { matcher: { id: 'byName', options: name }, properties };
}

const LEVEL_OVERRIDES = [
    seriesOverride('error', STATUS.critical),
    seriesOverride('warn', STATUS.warning),
    seriesOverride('info', SLOT[0]),
];

// the services cv-app calls, by host (client.name of http.client.requests)
const CLIENTS = [
    ['ollama.com', 'LLM в облаке (ollama.com)'],
    ['cv-ollama', 'LLM локально (GPU)'],
    ['cv-whisper-app', 'Whisper'],
    ['kokoro-tts', 'TTS английский (Kokoro)'],
    ['estonian-tts-spring-app-1', 'TTS эстонский'],
    ['cv-ollama-cpu', 'Ollama CPU (эмбеддинги)'],
];
const CLIENT_OVERRIDES = CLIENTS.map(([host, name], i) => seriesOverride(host, SLOT[i], name));

function row(title, y) {
    return { type: 'row', id: nextId++, title, collapsed: false, panels: [], gridPos: { x: 0, y, w: 24, h: 1 } };
}

function timeseries({ title, description, targets, unit, gridPos, overrides = [], bars = false, stack = false, min = 0, max, decimals }) {
    return {
        type: 'timeseries', id: nextId++, title, description, gridPos,
        datasource: targets[0].datasource,
        targets: withRefIds(targets),
        fieldConfig: {
            defaults: {
                unit, min, max, decimals,
                color: { mode: 'palette-classic' },
                custom: {
                    drawStyle: bars ? 'bars' : 'line',
                    lineWidth: 2,
                    fillOpacity: bars ? 70 : 6,
                    gradientMode: 'none',
                    showPoints: 'never',
                    lineInterpolation: 'linear',
                    spanNulls: false,
                    axisBorderShow: false,
                    axisPlacement: 'auto',
                    stacking: { mode: stack ? 'normal' : 'none', group: 'A' },
                },
            },
            overrides,
        },
        options: {
            legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
            tooltip: { mode: 'multi', sort: 'desc' },
        },
    };
}

function stat({ title, description, targets, unit, gridPos, decimals, thresholds, graph = true, mappings }) {
    return {
        type: 'stat', id: nextId++, title, description, gridPos,
        datasource: targets[0].datasource,
        targets: withRefIds(targets),
        fieldConfig: {
            defaults: {
                unit, decimals, mappings,
                color: thresholds ? { mode: 'thresholds' } : { mode: 'fixed', fixedColor: 'text' },
                thresholds: thresholds || { mode: 'absolute', steps: [{ color: 'text', value: null }] },
            },
            overrides: [],
        },
        options: {
            reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
            colorMode: thresholds ? 'value' : 'none',
            graphMode: graph ? 'area' : 'none',
            textMode: 'auto',
            justifyMode: 'center',
            orientation: 'auto',
            showPercentChange: false,
            wideLayout: true,
        },
    };
}

function barGauge({ title, description, targets, unit, gridPos, decimals }) {
    return {
        type: 'bargauge', id: nextId++, title, description, gridPos,
        datasource: targets[0].datasource,
        targets: withRefIds(targets),
        fieldConfig: {
            defaults: {
                unit, decimals, min: 0,
                // one series: one color for every bar (no value ramp on nominal categories)
                color: { mode: 'fixed', fixedColor: SLOT[0] },
            },
            overrides: [],
        },
        options: {
            orientation: 'horizontal',
            displayMode: 'basic',
            valueMode: 'text',
            namePlacement: 'left',
            showUnfilled: true,
            sizing: 'auto',
            minVizHeight: 16,
            maxVizHeight: 22,
            reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
        },
    };
}

function logs({ title, description, expr, gridPos }) {
    return {
        type: 'logs', id: nextId++, title, description, gridPos,
        datasource: LOKI,
        targets: withRefIds([{ datasource: LOKI, expr, queryType: 'range' }]),
        options: {
            showTime: true,
            showLabels: false,
            showCommonLabels: false,
            wrapLogMessage: true,
            prettifyLogMessage: false,
            enableLogDetails: true,
            enableInfiniteScrolling: true,
            dedupStrategy: 'none',
            sortOrder: 'Descending',
        },
    };
}

function dashboard({ uid, title, description, panels, templating = [], time = 'now-24h', refresh = '1m', tags }) {
    return {
        uid, title, description, tags,
        editable: true,
        graphTooltip: 1,
        timezone: 'browser',
        schemaVersion: 41,
        version: 1,
        time: { from: time, to: 'now' },
        refresh,
        templating: { list: templating },
        annotations: { list: [] },
        links: [
            { title: 'Обзор', type: 'link', url: '/d/gaile-overview', icon: 'dashboard' },
            { title: 'Логи', type: 'link', url: '/d/gaile-logs', icon: 'doc' },
            { title: 'JVM', type: 'link', url: '/d/gaile-jvm', icon: 'dashboard' },
        ],
        panels,
    };
}

// ---------------------------------------------------------------- overview
nextId = 1;
const API = 'application="cv", uri!~"/actuator.*"';
const overview = dashboard({
    uid: 'gaile-overview',
    title: 'gaile.ee — обзор',
    description: 'Нагрузка на сайт, вызовы LLM/Whisper/TTS, GPU и контейнеры, ошибки в логах',
    tags: ['gaile.ee'],
    panels: [
        stat({
            title: 'Сервисы',
            description: 'Spring-приложения и RabbitMQ — отдают ли метрики (up); Kokoro, Whisper-сервис, Ollama и сам сайт gaile.ee (как его открывает посетитель: роутер, nginx для Windows, cv-ui) — отвечают ли на проверку blackbox exporter (probe_success)',
            gridPos: { x: 0, y: 0, w: 20, h: 3 },
            targets: [prom('sort(up{job=~"spring|rabbitmq"} or probe_success)', '{{instance}}', { instant: true, range: false })],
            graph: false,
            mappings: [{ type: 'value', options: { '0': { text: 'не отвечает', index: 0 }, '1': { text: 'работает', index: 1 } } }],
            thresholds: { mode: 'absolute', steps: [{ color: STATUS.critical, value: null }, { color: STATUS.good, value: 1 }] },
        }),
        stat({
            title: 'Сертификат gaile.ee',
            description: 'Сколько дней до окончания сертификата сайта (cv-ui, /etc/nginx/certs). Алерт — меньше 14 дней',
            gridPos: { x: 20, y: 0, w: 4, h: 3 },
            targets: [prom('(probe_ssl_earliest_cert_expiry{job="probe-site"} - time()) / 86400', 'дней', { instant: true, range: false })],
            unit: 'suffix: дн.', decimals: 0, graph: false,
            thresholds: { mode: 'absolute', steps: [{ color: STATUS.critical, value: null }, { color: STATUS.warning, value: 14 }, { color: STATUS.good, value: 30 }] },
        }),
        stat({
            title: 'Запросы к API в минуту',
            gridPos: { x: 0, y: 3, w: 4, h: 4 },
            targets: [prom(`sum(rate(http_server_requests_seconds_count{${API}}[5m])) * 60`, 'запросов в минуту')],
            unit: 'short', decimals: 1,
        }),
        stat({
            title: 'p95 ответа API',
            description: '95% запросов к cv-app быстрее этого времени (за 5 минут). Ответы чата ждут LLM, поэтому p95 бывает в секундах',
            gridPos: { x: 4, y: 3, w: 4, h: 4 },
            targets: [prom(`histogram_quantile(0.95, sum by (le) (rate(http_server_requests_seconds_bucket{${API}}[5m])))`, 'p95')],
            unit: 's', decimals: 2,
        }),
        stat({
            title: 'Ответы 5xx за час',
            description: 'Все Spring-приложения',
            gridPos: { x: 8, y: 3, w: 4, h: 4 },
            targets: [prom('sum(increase(http_server_requests_seconds_count{status=~"5.."}[1h])) or vector(0)', '5xx')],
            unit: 'short', decimals: 0,
            thresholds: { mode: 'absolute', steps: [{ color: 'text', value: null }, { color: STATUS.critical, value: 1 }] },
        }),
        stat({
            title: 'Ошибки в логах за час',
            description: 'Строки с уровнем error во всех контейнерах, кроме самого мониторинга (контейнеры obs-*)',
            gridPos: { x: 12, y: 3, w: 4, h: 4 },
            targets: [loki('sum(count_over_time({level="error", container!~"obs-.*"}[1h])) or vector(0)', 'ошибок', { queryType: 'instant' })],
            unit: 'short', decimals: 0, graph: false,
            thresholds: { mode: 'absolute', steps: [{ color: 'text', value: null }, { color: STATUS.critical, value: 1 }] },
        }),
        stat({
            title: 'Загрузка GPU',
            gridPos: { x: 16, y: 3, w: 4, h: 4 },
            targets: [prom('avg(nvidia_smi_utilization_gpu_ratio)', 'GPU')],
            unit: 'percentunit', decimals: 0,
        }),
        stat({
            title: 'Память GPU занята',
            description: 'Когда память кончается, Ollama выгружает слои модели на CPU и отвечает в разы медленнее',
            gridPos: { x: 20, y: 3, w: 4, h: 4 },
            targets: [prom('sum(nvidia_smi_memory_used_bytes) / sum(nvidia_smi_memory_total_bytes)', 'VRAM')],
            unit: 'percentunit', decimals: 0,
            thresholds: { mode: 'absolute', steps: [{ color: 'text', value: null }, { color: STATUS.warning, value: 0.85 }, { color: STATUS.critical, value: 0.95 }] },
        }),

        row('API сайта (cv-app)', 7),
        timeseries({
            title: 'Запросы в минуту по результату',
            gridPos: { x: 0, y: 8, w: 12, h: 8 },
            targets: [prom(`sum by (outcome) (rate(http_server_requests_seconds_count{${API}}[5m])) * 60`, '{{outcome}}')],
            unit: 'short',
            overrides: [
                seriesOverride('SUCCESS', SLOT[0], 'успешно (2xx)'),
                seriesOverride('REDIRECTION', SLOT[6], 'перенаправление (3xx)'),
                seriesOverride('CLIENT_ERROR', STATUS.warning, 'ошибка клиента (4xx)'),
                seriesOverride('SERVER_ERROR', STATUS.critical, 'ошибка сервера (5xx)'),
            ],
        }),
        timeseries({
            title: 'Время ответа API',
            gridPos: { x: 12, y: 8, w: 12, h: 8 },
            targets: [
                prom(`histogram_quantile(0.5, sum by (le) (rate(http_server_requests_seconds_bucket{${API}}[5m])))`, 'медиана'),
                prom(`histogram_quantile(0.95, sum by (le) (rate(http_server_requests_seconds_bucket{${API}}[5m])))`, 'p95'),
            ],
            unit: 's',
            overrides: [seriesOverride('медиана', SLOT[0]), seriesOverride('p95', SLOT[1])],
        }),
        {
            type: 'table', id: nextId++, title: 'Эндпоинты за выбранный период',
            description: 'Сколько раз вызывали, 95-й процентиль времени и число ответов 5xx',
            gridPos: { x: 0, y: 16, w: 24, h: 9 },
            datasource: PROM,
            targets: [
                promInstant(`sum by (method, uri) (increase(http_server_requests_seconds_count{${API}}[$__range]))`, 'A'),
                promInstant(`histogram_quantile(0.95, sum by (method, uri, le) (increase(http_server_requests_seconds_bucket{${API}}[$__range])))`, 'B'),
                promInstant(`sum by (method, uri) (increase(http_server_requests_seconds_count{${API}, status=~"5.."}[$__range]))`, 'C'),
            ],
            transformations: [
                { id: 'merge', options: {} },
                {
                    id: 'organize',
                    options: {
                        excludeByName: { Time: true },
                        indexByName: { method: 0, uri: 1, 'Value #A': 2, 'Value #B': 3, 'Value #C': 4 },
                        renameByName: { method: 'Метод', uri: 'Эндпоинт', 'Value #A': 'Запросы', 'Value #B': 'p95', 'Value #C': 'Ответы 5xx' },
                    },
                },
                { id: 'filterByValue', options: { type: 'exclude', match: 'all', filters: [{ fieldName: 'Запросы', config: { id: 'lower', options: { value: 0.5 } } }] } },
            ],
            fieldConfig: {
                defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' } } },
                overrides: [
                    { matcher: { id: 'byName', options: 'Запросы' }, properties: [{ id: 'decimals', value: 0 }] },
                    { matcher: { id: 'byName', options: 'p95' }, properties: [{ id: 'unit', value: 's' }, { id: 'decimals', value: 2 }] },
                    { matcher: { id: 'byName', options: 'Ответы 5xx' }, properties: [{ id: 'decimals', value: 0 }, { id: 'noValue', value: '0' }] },
                ],
            },
            options: { showHeader: true, cellHeight: 'sm', sortBy: [{ displayName: 'Запросы', desc: true }], footer: { show: false } },
        },

        row('LLM, Whisper, TTS — вызовы из cv-app', 25),
        timeseries({
            title: 'Вызовы в минуту',
            description: 'Облачная и локальная LLM стартуют параллельно, если облако не ответило за ollama.cloud.fallback-delay-ms: проигравший вызов прерывается',
            gridPos: { x: 0, y: 26, w: 12, h: 8 },
            targets: [prom('sum by (client_name) (rate(http_client_requests_seconds_count{application="cv"}[5m])) * 60', '{{client_name}}')],
            unit: 'short', overrides: CLIENT_OVERRIDES,
        }),
        timeseries({
            title: 'Время ответа, p95 (успешные вызовы)',
            gridPos: { x: 12, y: 26, w: 12, h: 8 },
            targets: [prom('histogram_quantile(0.95, sum by (client_name, le) (rate(http_client_requests_seconds_bucket{application="cv", outcome="SUCCESS"}[5m])))', '{{client_name}}')],
            unit: 's', overrides: CLIENT_OVERRIDES,
        }),
        barGauge({
            title: 'Вызовы LLM за период по результату',
            description: 'SUCCESS — ответ получен; UNKNOWN — вызов прерван (ответил другой) или сорвался; CLIENT/SERVER_ERROR — ответ с ошибкой',
            gridPos: { x: 0, y: 34, w: 12, h: 8 },
            targets: [prom('sort_desc(sum by (client_name, outcome) (increase(http_client_requests_seconds_count{application="cv", client_name=~"ollama.com|cv-ollama"}[$__range])))', '{{client_name}} · {{outcome}}', { instant: true, range: false })],
            unit: 'short', decimals: 0,
        }),
        timeseries({
            title: 'Фоновые задачи: среднее время выполнения',
            description: '@Scheduled-задачи всех Spring-приложений: анализ беглости, проверка прокси, базы IP и т. д.',
            gridPos: { x: 12, y: 34, w: 12, h: 8 },
            targets: [prom('sum by (code_function) (rate(tasks_scheduled_execution_seconds_sum[15m])) / sum by (code_function) (rate(tasks_scheduled_execution_seconds_count[15m]))', '{{code_function}}')],
            unit: 's',
        }),

        row('Ресурсы', 42),
        timeseries({
            title: 'GPU: загрузка',
            gridPos: { x: 0, y: 43, w: 8, h: 8 },
            targets: [prom('avg(nvidia_smi_utilization_gpu_ratio)', 'загрузка')],
            unit: 'percentunit', max: 1, overrides: [seriesOverride('загрузка', SLOT[0])],
        }),
        timeseries({
            title: 'GPU: память',
            gridPos: { x: 8, y: 43, w: 8, h: 8 },
            targets: [
                prom('sum(nvidia_smi_memory_used_bytes)', 'занято'),
                prom('sum(nvidia_smi_memory_total_bytes)', 'всего'),
            ],
            unit: 'bytes',
            overrides: [
                seriesOverride('занято', SLOT[0]),
                { matcher: { id: 'byName', options: 'всего' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: 'text' } }, { id: 'custom.fillOpacity', value: 0 }, { id: 'custom.lineWidth', value: 1 }] },
            ],
        }),
        timeseries({
            title: 'GPU: температура',
            gridPos: { x: 16, y: 43, w: 8, h: 8 },
            targets: [prom('max(nvidia_smi_temperature_gpu)', 'температура')],
            unit: 'celsius', min: undefined, overrides: [seriesOverride('температура', SLOT[1])],
        }),
        timeseries({
            title: 'CPU контейнеров (ядра), 8 самых загруженных',
            gridPos: { x: 0, y: 51, w: 12, h: 9 },
            targets: [prom('sum by (name) (rate(container_cpu_usage_seconds_total[5m])) and on (name) topk(8, avg_over_time(sum by (name) (rate(container_cpu_usage_seconds_total[5m]))[$__range:1m]))', '{{name}}')],
            unit: 'short', decimals: 2,
        }),
        barGauge({
            title: 'Память контейнеров сейчас',
            gridPos: { x: 12, y: 51, w: 12, h: 9 },
            targets: [prom('sort_desc(sum by (name) (container_memory_working_set_bytes))', '{{name}}', { instant: true, range: false })],
            unit: 'bytes',
        }),

        row('Логи', 60),
        timeseries({
            title: 'Ошибки в логах по контейнерам',
            gridPos: { x: 0, y: 61, w: 24, h: 7 },
            targets: [loki('sum by (container) (count_over_time({level="error", container!~"obs-.*"}[$__auto]))', '{{container}}')],
            unit: 'short', bars: true, stack: true, decimals: 0,
        }),
        logs({
            title: 'Последние ошибки и предупреждения',
            description: 'Всё остальное — в дашборде «Логи»',
            expr: '{level=~"error|warn", container!~"obs-.*"}',
            gridPos: { x: 0, y: 68, w: 24, h: 12 },
        }),
    ],
});

// ---------------------------------------------------------------- logs
nextId = 1;
// $monitoring is "obs-.*" (the own lines of this stack, all its containers are obs-*, hidden) or "-" (no container has this name: all shown)
const SELECTOR = '{container=~"$container", level=~"$level", container!~"$monitoring"} |~ "(?i)$search"';
const logsDashboard = dashboard({
    uid: 'gaile-logs',
    title: 'gaile.ee — логи',
    description: 'Логи всех контейнеров: фильтр по контейнеру, уровню и тексту',
    tags: ['gaile.ee'],
    time: 'now-6h',
    refresh: '',
    templating: [
        {
            name: 'container', label: 'Контейнер', type: 'query', datasource: LOKI,
            query: { label: 'container', refId: 'LokiVariableQueryEditor-VariableQuery', stream: '', type: 1 },
            definition: 'label_values(container)',
            includeAll: true, allValue: '.+', multi: true, refresh: 2, sort: 1,
            current: { selected: true, text: ['All'], value: ['$__all'] },
        },
        {
            name: 'level', label: 'Уровень', type: 'custom', query: 'error,warn,info',
            description: 'All — и строки, в которых уровень не распознан',
            includeAll: true, allValue: '.*', multi: true,
            current: { selected: true, text: ['error', 'warn'], value: ['error', 'warn'] },
            options: [
                { selected: false, text: 'All', value: '$__all' },
                { selected: true, text: 'error', value: 'error' },
                { selected: true, text: 'warn', value: 'warn' },
                { selected: false, text: 'info', value: 'info' },
            ],
        },
        {
            name: 'monitoring', label: 'Мониторинг', type: 'custom',
            description: 'Строки самих Grafana, Loki, Alloy, Prometheus: их запуск и остановка к приложениям не относятся',
            query: 'скрыть : obs-.*,показать : -',
            includeAll: false, multi: false,
            current: { selected: true, text: 'скрыть', value: 'obs-.*' },
            options: [
                { selected: true, text: 'скрыть', value: 'obs-.*' },
                { selected: false, text: 'показать', value: '-' },
            ],
        },
        {
            name: 'search', label: 'Текст (regex)', type: 'textbox', query: '',
            current: { selected: false, text: '', value: '' },
            options: [{ selected: true, text: '', value: '' }],
        },
        {
            name: 'trace', label: 'traceId', type: 'textbox', query: '',
            description: 'traceId из строки Spring-приложения ([traceId-spanId] после имени потока): панель внизу покажет все строки этого запроса во всех приложениях, любого уровня',
            current: { selected: false, text: '', value: '' },
            options: [{ selected: true, text: '', value: '' }],
        },
    ],
    panels: [
        timeseries({
            title: 'Строк по уровням',
            gridPos: { x: 0, y: 0, w: 24, h: 6 },
            targets: [loki(`sum by (level) (count_over_time(${SELECTOR} [$__auto]))`, '{{level}}')],
            unit: 'short', bars: true, stack: true, decimals: 0,
            overrides: LEVEL_OVERRIDES,
        }),
        logs({
            title: 'Логи',
            expr: SELECTOR,
            gridPos: { x: 0, y: 6, w: 24, h: 18 },
        }),
        logs({
            title: 'cv-app: вход, регистрация, выход (access-accounting-log)',
            expr: '{container="cv-app"} | logger="access-accounting-log"',
            gridPos: { x: 0, y: 24, w: 12, h: 10 },
        }),
        logs({
            title: 'Медленные запросы к сайту (nginx, дольше 2 с)',
            description: 'rt — секунды от первого байта запроса до записи в лог, len — принятые байты (с телом): у 408 видно, сколько загрузки дошло',
            expr: '{container="cv-ui"} | rt > 2',
            gridPos: { x: 12, y: 24, w: 12, h: 10 },
        }),
        logs({
            title: 'Ошибки скриптов в браузерах посетителей (client-error-log)',
            description: 'Frontend отправляет ошибки своих скриптов в cv-app (ClientErrorHandler → ClientErrorLog): страница, адрес, браузер, сообщение и стек',
            expr: '{container="cv-app"} | logger="client-error-log"',
            gridPos: { x: 0, y: 34, w: 12, h: 10 },
        }),
        logs({
            title: 'PostgreSQL: медленные запросы, блокировки, ошибки',
            description: 'Запросы дольше 500 мс (duration_ms), ожидание блокировки дольше секунды, сортировка на диске — настройки в docker-compose.yml CV',
            expr: '{container="cv-postgres", level=~"warn|error"}',
            gridPos: { x: 12, y: 34, w: 12, h: 10 },
        }),
        logs({
            title: 'Все строки одного запроса (traceId)',
            description: 'Введите traceId вверху. Строки cv-app, Whisper и Estonian TTS с этим traceId — входящий запрос, вызовы LLM, фоновые задачи, которые он запустил',
            // an empty $trace matches only an empty trace_id, which the second filter drops: nothing is shown
            expr: '{container=~".+"} | trace_id=~"$trace" | trace_id!=""',
            gridPos: { x: 0, y: 44, w: 24, h: 12 },
        }),
    ],
});

// ---------------------------------------------------------------- JVM
nextId = 1;
const APP = 'application="$application"';
const jvm = dashboard({
    uid: 'gaile-jvm',
    title: 'gaile.ee — JVM',
    description: 'Память, GC, потоки и пул соединений Spring-приложений',
    tags: ['gaile.ee'],
    time: 'now-6h',
    templating: [
        {
            name: 'application', label: 'Приложение', type: 'query', datasource: PROM,
            query: { query: 'label_values(jvm_memory_used_bytes, application)', refId: 'PrometheusVariableQueryEditor-VariableQuery', qryType: 1 },
            definition: 'label_values(jvm_memory_used_bytes, application)',
            refresh: 2, sort: 1, includeAll: false, multi: false,
            current: { selected: true, text: 'cv', value: 'cv' },
        },
    ],
    panels: [
        stat({ title: 'Работает', gridPos: { x: 0, y: 0, w: 6, h: 4 }, targets: [prom(`process_uptime_seconds{${APP}}`, 'uptime')], unit: 's', graph: false }),
        stat({ title: 'Heap занят', gridPos: { x: 6, y: 0, w: 6, h: 4 }, targets: [prom(`sum(jvm_memory_used_bytes{${APP}, area="heap"}) / sum(jvm_memory_max_bytes{${APP}, area="heap"} > 0)`, 'heap')], unit: 'percentunit', decimals: 0 }),
        stat({ title: 'CPU процесса', gridPos: { x: 12, y: 0, w: 6, h: 4 }, targets: [prom(`process_cpu_usage{${APP}}`, 'CPU')], unit: 'percentunit', decimals: 1 }),
        stat({ title: 'Потоки', description: 'Платформенные потоки: виртуальные сюда не входят', gridPos: { x: 18, y: 0, w: 6, h: 4 }, targets: [prom(`jvm_threads_live_threads{${APP}}`, 'потоки')], unit: 'short', decimals: 0 }),
        timeseries({
            title: 'Heap', gridPos: { x: 0, y: 4, w: 12, h: 8 },
            targets: [
                prom(`sum(jvm_memory_used_bytes{${APP}, area="heap"})`, 'занято'),
                prom(`sum(jvm_memory_committed_bytes{${APP}, area="heap"})`, 'выделено'),
                prom(`sum(jvm_memory_max_bytes{${APP}, area="heap"} > 0)`, 'максимум'),
            ],
            unit: 'bytes',
            overrides: [
                seriesOverride('занято', SLOT[0]), seriesOverride('выделено', SLOT[2]),
                { matcher: { id: 'byName', options: 'максимум' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: 'text' } }, { id: 'custom.fillOpacity', value: 0 }, { id: 'custom.lineWidth', value: 1 }] },
            ],
        }),
        timeseries({
            title: 'Non-heap', gridPos: { x: 12, y: 4, w: 12, h: 8 },
            targets: [prom(`sum by (id) (jvm_memory_used_bytes{${APP}, area="nonheap"})`, '{{id}}')],
            unit: 'bytes',
        }),
        timeseries({
            title: 'Время в паузах GC (секунд в секунду)', gridPos: { x: 0, y: 12, w: 12, h: 8 },
            targets: [prom(`sum by (gc) (rate(jvm_gc_pause_seconds_sum{${APP}}[5m]))`, '{{gc}}')],
            unit: 'percentunit', decimals: 2,
        }),
        timeseries({
            title: 'CPU', gridPos: { x: 12, y: 12, w: 12, h: 8 },
            targets: [
                prom(`process_cpu_usage{${APP}}`, 'процесс'),
                prom(`system_cpu_usage{${APP}}`, 'контейнер (вся система)'),
            ],
            unit: 'percentunit', max: 1,
            overrides: [seriesOverride('процесс', SLOT[0]), seriesOverride('контейнер (вся система)', SLOT[1])],
        }),
        timeseries({
            title: 'Пул соединений с БД (Hikari)', description: 'Только у приложений с базой (cv). pending > 0 — запросы ждут свободного соединения',
            gridPos: { x: 0, y: 20, w: 12, h: 8 },
            targets: [
                prom(`sum(hikaricp_connections_active{${APP}})`, 'заняты'),
                prom(`sum(hikaricp_connections_idle{${APP}})`, 'свободны'),
                prom(`sum(hikaricp_connections_pending{${APP}})`, 'ждут'),
            ],
            unit: 'short', decimals: 0,
            overrides: [seriesOverride('заняты', SLOT[0]), seriesOverride('свободны', SLOT[2]), seriesOverride('ждут', STATUS.critical)],
        }),
        timeseries({
            title: 'Потоки по состоянию', gridPos: { x: 12, y: 20, w: 12, h: 8 },
            targets: [prom(`sum by (state) (jvm_threads_states_threads{${APP}})`, '{{state}}')],
            unit: 'short', decimals: 0,
        }),
    ],
});

for (const [file, d] of [['overview.json', overview], ['logs.json', logsDashboard], ['jvm.json', jvm]]) {
    fs.writeFileSync(path.join(OUT, file), JSON.stringify(d, null, 2) + '\n');
    console.log('written', file, d.panels.length, 'panels');
}
