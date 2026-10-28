const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  CONFIG_MARKER,
  CodexProxy,
  accessTokenExpiresAtMs,
  buildBaseUrlLine,
  injectBaseUrl,
  parseRetryDelayMs,
  refreshAuthFileIfStale,
  stripCodePetProxyLines,
} = require("../src/codex-proxy");

function fakeJwt(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

// 테스트용 계정 풀: authPath를 실제 파일 대신 토큰 문자열 자체로 씁니다.
function poolProxy({ upstreamPort, accounts, notifySwitch, port }) {
  return new CodexProxy({
    upstreamBase: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    port,
    resolveAccounts: async () => accounts,
    readAuth: (authPath) => ({ accessToken: authPath, accountId: `id-${authPath}` }),
    notifySwitch,
  });
}

function startUpstream(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// 원시 요청을 보내고 상태 줄만 돌려줍니다. 브라우저가 붙이는 헤더를 그대로 흉내 내기 위해 씁니다.
function rawRequest(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write([...lines, "", ""].join("\r\n")));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw request timeout"));
    }, 4000);
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n")) {
        clearTimeout(timer);
        socket.destroy();
        resolve(data.split("\r\n")[0]);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("config 주입은 루트 영역의 첫 테이블 앞에 marker와 base_url을 넣는다", () => {
  const content = ['model = "gpt-5"', "", "[plugins.chrome]", 'x = "y"'].join("\n");
  const result = injectBaseUrl(content, 10161);
  const lines = result.content.split("\n");
  const markerIndex = lines.indexOf(CONFIG_MARKER);

  assert.equal(result.keptUserBaseUrl, false);
  assert.ok(markerIndex >= 0);
  assert.equal(lines[markerIndex + 1], buildBaseUrlLine(10161));
  assert.ok(markerIndex < lines.indexOf("[plugins.chrome]"));
});

test("config 주입은 멱등이고 사용자 소유 openai_base_url은 존중한다", () => {
  const first = injectBaseUrl("", 10161).content;
  const second = injectBaseUrl(first, 10162).content;
  assert.equal(second.split("\n").filter((line) => line === CONFIG_MARKER).length, 1);
  assert.match(second, /10162/);
  assert.doesNotMatch(second, /10161/);

  const userOwned = injectBaseUrl('openai_base_url = "http://127.0.0.1:9/v1"', 10161);
  assert.equal(userOwned.keptUserBaseUrl, true);
  assert.doesNotMatch(userOwned.content, /10161/);
});

test("config 제거는 marker와 그 다음 base_url 줄만 걷어낸다", () => {
  const injected = injectBaseUrl(['model = "gpt-5"', "[a]", 'b = "c"'].join("\n"), 10161).content;
  const stripped = stripCodePetProxyLines(injected);
  assert.doesNotMatch(stripped, /codepet-codex-proxy|openai_base_url/);
  assert.match(stripped, /model = "gpt-5"/);
  assert.match(stripped, /\[a\]/);
});

test("JWT exp 클레임으로 만료 시각을 계산하고 형식이 다르면 null을 준다", () => {
  assert.equal(accessTokenExpiresAtMs(fakeJwt({ exp: 1000 })), 1000 * 1000);
  assert.equal(accessTokenExpiresAtMs("not-a-jwt"), null);
});

test("만료 임박한 Codex 토큰은 refresh token으로 갱신하고 auth 파일에 원자 저장한다", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-proxy-refresh-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const authPath = path.join(home, "auth.json");
  const original = {
    auth_mode: "chatgpt",
    tokens: {
      account_id: "workspace-a",
      access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 30 }),
      refresh_token: "refresh-old",
      id_token: "id-old",
    },
  };
  fs.writeFileSync(authPath, JSON.stringify(original), "utf8");

  let request = null;
  const refreshed = await refreshAuthFileIfStale(authPath, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return {
            access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            refresh_token: "refresh-new",
            id_token: "id-new",
          };
        },
      };
    },
  });

  const saved = JSON.parse(fs.readFileSync(authPath, "utf8"));
  assert.match(request.url, /auth\.openai\.com\/oauth\/token$/);
  assert.equal(JSON.parse(request.options.body).refresh_token, "refresh-old");
  assert.equal(refreshed.tokens.refresh_token, "refresh-new");
  assert.equal(saved.tokens.refresh_token, "refresh-new");
  assert.equal(saved.tokens.account_id, "workspace-a");
  assert.ok(saved.last_refresh);
});

test("429 응답의 재시도 지연은 retry-after 헤더와 본문 필드를 순서대로 읽는다", () => {
  assert.equal(parseRetryDelayMs("", { "retry-after": "30" }), 30000);
  assert.equal(parseRetryDelayMs('{"resets_in_seconds":120}'), 120000);
  assert.equal(parseRetryDelayMs("plain text"), null);
});

test("프록시는 /v1 경로를 벗기고 활성 계정 인증 헤더를 주입해 중계한다", async () => {
  let seen = null;
  const upstream = await startUpstream((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen = { url: request.url, headers: request.headers, body };
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });

  const proxy = poolProxy({
    upstreamPort: upstream.address().port,
    accounts: [{ key: "a", label: "A", authPath: "token-a" }],
    port: 19161,
  });
  const proxyPort = await proxy.start();

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer stale-desktop-token",
        "chatgpt-account-id": "acct-old",
        session_id: "sess-1",
      },
      body: '{"model":"gpt-5"}',
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(seen.url, "/backend-api/codex/responses");
    assert.equal(seen.headers.authorization, "Bearer token-a");
    assert.equal(seen.headers["chatgpt-account-id"], "id-token-a");
    assert.equal(seen.headers.session_id, "sess-1");
    assert.equal(seen.body, '{"model":"gpt-5"}');
  } finally {
    proxy.stop();
    upstream.close();
  }
});

test("한도(429)를 맞으면 다음 계정으로 자동 로테이션하고 쿨다운을 기록한다", async () => {
  const hits = [];
  const upstream = await startUpstream((request, response) => {
    hits.push(request.headers.authorization);
    if (request.headers.authorization === "Bearer token-a") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end('{"resets_in_seconds":3600}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":"b"}');
  });

  const switched = [];
  const proxy = poolProxy({
    upstreamPort: upstream.address().port,
    accounts: [
      { key: "a", label: "A", authPath: "token-a" },
      { key: "b", label: "B", authPath: "token-b" },
    ],
    notifySwitch: (account, reason) => switched.push({ key: account.key, reason }),
    port: 19181,
  });
  const proxyPort = await proxy.start();

  try {
    const first = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: "b" });
    assert.deepEqual(hits, ["Bearer token-a", "Bearer token-b"]);
    assert.deepEqual(switched, [{ key: "b", reason: "quota" }]);
    assert.equal(proxy.isCoolingDown("a"), true);
    assert.equal(proxy.isCoolingDown("b"), false);

    // 쿨다운 중에는 a를 건너뛰고 바로 b로 갑니다.
    hits.length = 0;
    const second = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(second.status, 200);
    assert.deepEqual(hits, ["Bearer token-b"]);
  } finally {
    proxy.stop();
    upstream.close();
  }
});

test("인증 실패(401)를 맞으면 같은 요청을 다음 계정으로 재시도하고 실패 계정을 쿨다운한다", async () => {
  const hits = [];
  const upstream = await startUpstream((request, response) => {
    hits.push(request.headers.authorization);
    if (request.headers.authorization === "Bearer token-a") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"expired"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":"b"}');
  });

  const proxy = poolProxy({
    upstreamPort: upstream.address().port,
    accounts: [
      { key: "a", label: "A", authPath: "token-a" },
      { key: "b", label: "B", authPath: "token-b" },
    ],
    port: 19186,
  });
  const proxyPort = await proxy.start();

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: "b" });
    assert.deepEqual(hits, ["Bearer token-a", "Bearer token-b"]);
    assert.equal(proxy.isCoolingDown("a"), true);
    assert.equal(proxy.isCoolingDown("b"), false);
  } finally {
    proxy.stop();
    upstream.close();
  }
});

test("모든 계정이 한도 초과면 마지막 429 응답을 그대로 전달한다", async () => {
  const upstream = await startUpstream((request, response) => {
    response.writeHead(429, { "content-type": "application/json" });
    response.end('{"error":"limit"}');
  });

  const proxy = poolProxy({
    upstreamPort: upstream.address().port,
    accounts: [
      { key: "a", label: "A", authPath: "token-a" },
      { key: "b", label: "B", authPath: "token-b" },
    ],
    port: 19191,
  });
  const proxyPort = await proxy.start();

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 429);
    assert.equal(proxy.isCoolingDown("a"), true);
    assert.equal(proxy.isCoolingDown("b"), true);
  } finally {
    proxy.stop();
    upstream.close();
  }
});

test("저장 계정이 없으면 들어온 인증 헤더를 그대로 통과시킨다", async () => {
  let seen = null;
  const upstream = await startUpstream((request, response) => {
    seen = request.headers;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });

  const proxy = new CodexProxy({
    upstreamBase: `http://127.0.0.1:${upstream.address().port}`,
    port: 19171,
    resolveAccounts: async () => [],
  });
  const proxyPort = await proxy.start();

  try {
    await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer passthrough-token" },
      body: "{}",
    });
    assert.equal(seen.authorization, "Bearer passthrough-token");
  } finally {
    proxy.stop();
    upstream.close();
  }
});

test("WebSocket 업그레이드는 인증을 갈아끼운 원시 터널로 중계한다", async () => {
  let upgradeHeaders = null;
  const upstream = http.createServer();
  upstream.on("upgrade", (request, socket) => {
    upgradeHeaders = request.headers;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
    );
    socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const proxy = poolProxy({
    upstreamPort: upstream.address().port,
    accounts: [{ key: "a", label: "A", authPath: "token-a" }],
    port: 19201,
  });
  const proxyPort = await proxy.start();

  try {
    const result = await new Promise((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => {
        socket.write(
          [
            "GET /v1/responses HTTP/1.1",
            `Host: 127.0.0.1:${proxyPort}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Key: dGVzdA==",
            "Sec-WebSocket-Version: 13",
            "Authorization: Bearer stale-token",
            "",
            "",
          ].join("\r\n")
        );
      });
      let data = "";
      let sentPayload = false;
      socket.on("data", (chunk) => {
        data += chunk;
        if (!sentPayload && data.includes("101")) {
          sentPayload = true;
          socket.write("ping");
          return;
        }
        if (data.includes("echo:ping")) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.once("error", reject);
      setTimeout(() => reject(new Error("websocket test timeout")), 5000);
    });

    assert.match(result, /101 Switching Protocols/);
    assert.match(result, /echo:ping/);
    assert.equal(upgradeHeaders.authorization, "Bearer token-a");
    assert.equal(upgradeHeaders["chatgpt-account-id"], "id-token-a");
  } finally {
    proxy.stop();
    upstream.close();
  }
});

test("계정 전환은 기존 WebSocket만 끊고 재연결 handshake에 새 계정을 주입한다", async () => {
  const upgradeAuthorizations = [];
  const upstreamSockets = new Set();
  const upstream = http.createServer();
  upstream.on("upgrade", (request, socket) => {
    upgradeAuthorizations.push(request.headers.authorization);
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  let accounts = [{ key: "a", label: "A", authPath: "token-a" }];
  const proxy = new CodexProxy({
    upstreamBase: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
    port: 19206,
    resolveAccounts: async () => accounts,
    readAuth: (authPath) => ({ accessToken: authPath, accountId: `id-${authPath}` }),
  });
  const proxyPort = await proxy.start();

  const connectTunnel = () => new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(
        `GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:${proxyPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
      );
    });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("websocket reconnect test timeout"));
    }, 4000);
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk;
      if (!response.includes("101 Switching Protocols")) return;
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  try {
    const firstSocket = await connectTunnel();
    assert.deepEqual(upgradeAuthorizations, ["Bearer token-a"]);

    // 실제 main 흐름과 같은 순서: 활성 계정/캐시가 B를 가리킨 뒤 기존 터널을 끊습니다.
    accounts = [{ key: "b", label: "B", authPath: "token-b" }];
    const firstClosed = new Promise((resolve) => firstSocket.once("close", resolve));
    assert.equal(proxy.disconnectWebSocketTunnels("account-switch"), 1);
    await firstClosed;

    const secondSocket = await connectTunnel();
    assert.deepEqual(upgradeAuthorizations, ["Bearer token-a", "Bearer token-b"]);
    secondSocket.destroy();
  } finally {
    proxy.stop();
    for (const socket of upstreamSockets) socket.destroy();
    upstream.close();
  }
});

test("disableProxyInConfig는 마커가 없으면 파일을 건드리지 않는다", () => {
  const { disableProxyInConfig, enableProxyInConfig } = require("../src/codex-proxy");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-cfg-"));
  const cfg = path.join(dir, "config.toml");
  try {
    fs.writeFileSync(cfg, 'model = "gpt-5"\n');
    const before = fs.statSync(cfg).mtimeMs;
    disableProxyInConfig(cfg);
    // 마커가 없으므로 재기록되지 않아야 함 (내용 동일)
    assert.equal(fs.readFileSync(cfg, "utf8"), 'model = "gpt-5"\n');

    enableProxyInConfig(19999, cfg);
    assert.match(fs.readFileSync(cfg, "utf8"), /codepet-codex-proxy/);
    disableProxyInConfig(cfg);
    assert.doesNotMatch(fs.readFileSync(cfg, "utf8"), /codepet-codex-proxy/);
    assert.match(fs.readFileSync(cfg, "utf8"), /model = "gpt-5"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("계정 주입 시 클라이언트의 옛 chatgpt-account-id 헤더는 제거된다", async () => {
  let seen = null;
  const upstream = await startUpstream((request, response) => {
    seen = request.headers;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  // authPath에 accountId 없는 계정 (readAuth가 accountId 미포함 반환)
  const proxy = new CodexProxy({
    upstreamBase: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
    port: 19211,
    resolveAccounts: async () => [{ key: "a", label: "A", authPath: "token-a" }],
    readAuth: () => ({ accessToken: "token-a", accountId: null }),
  });
  const proxyPort = await proxy.start();
  try {
    await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer old", "chatgpt-account-id": "old-acct" },
      body: "{}",
    });
    assert.equal(seen.authorization, "Bearer token-a");
    // 주입 계정에 accountId가 없으면 옛 헤더가 새어나가면 안 됨
    assert.equal(seen["chatgpt-account-id"], undefined);
  } finally {
    proxy.stop();
    upstream.close();
  }
});

test("WebSocket 핸드셰이크 중 upstream이 닫으면 hang하지 않고 다음 후보로 넘어간다", async () => {
  let attempt = 0;
  // 첫 연결은 헤더 완성 전 소켓을 닫고, 두 번째는 101을 준다.
  const upstream = net.createServer((socket) => {
    attempt += 1;
    if (attempt === 1) {
      socket.on("data", () => socket.destroy());
      return;
    }
    socket.on("data", () => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const proxy = poolProxy({
    upstreamPort: upstream.address().port,
    accounts: [
      { key: "a", label: "A", authPath: "token-a" },
      { key: "b", label: "B", authPath: "token-b" },
    ],
    port: 19221,
  });
  const proxyPort = await proxy.start();

  try {
    const status = await new Promise((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => {
        socket.write(
          `GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:${proxyPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
        );
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\r\n")) {
          socket.destroy();
          resolve(data.split("\r\n")[0]);
        }
      });
      socket.once("error", reject);
      setTimeout(() => reject(new Error("hang: no response")), 4000);
    });
    assert.match(status, /101/);
  } finally {
    proxy.stop();
    upstream.close();
  }
});

// 브라우저(웹페이지) 요청 거부: 프록시가 저장 계정 토큰을 붙여 중계하므로 Codex 외의 호출자는 막습니다.
async function startGuardedProxy(port) {
  const hits = [];
  const upstream = await startUpstream((request, response) => {
    hits.push(request.headers.authorization);
    response.writeHead(200);
    response.end("{}");
  });
  upstream.on("upgrade", (request, socket) => {
    hits.push(request.headers.authorization);
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  const proxy = poolProxy({
    upstreamPort: upstream.address().port,
    accounts: [{ key: "a", label: "A", authPath: "token-a" }],
    port,
  });
  const proxyPort = await proxy.start();
  return { hits, upstream, proxy, proxyPort, close: () => { proxy.stop(); upstream.close(); } };
}

const UPGRADE = ["Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Key: dGVzdA==", "Sec-WebSocket-Version: 13"];

test("루프백이 아닌 Host로 들어온 요청은 토큰을 붙이지 않고 거부한다", async () => {
  const f = await startGuardedProxy(19241);
  try {
    const hosts = [
      `attacker.example:${f.proxyPort}`, `127.0.0.1.attacker.example:${f.proxyPort}`, `[::1]:${f.proxyPort}`,
      `localhost.:${f.proxyPort}`, "127.0.0.1", "localhost", `127.0.0.1:${f.proxyPort + 1}`,
      `127.0.0.2:${f.proxyPort}`, `127.1:${f.proxyPort}`,
    ];
    for (const host of hosts) {
      assert.match(await rawRequest(f.proxyPort, ["POST /v1/responses HTTP/1.1", `Host: ${host}`, "Content-Length: 0"]), / 403 /, host);
      assert.match(await rawRequest(f.proxyPort, ["GET /v1/responses HTTP/1.1", `Host: ${host}`, ...UPGRADE]), / 403 /, host);
    }
    // HTTP/1.0은 Host 없이 보낼 수 있습니다.
    assert.match(await rawRequest(f.proxyPort, ["GET /v1/models HTTP/1.0"]), / 403 /);
    assert.deepEqual(f.hits, []);

    // Codex처럼 루프백 Host로 오는 요청은 그대로 토큰을 붙여 중계합니다.
    for (const host of [`127.0.0.1:${f.proxyPort}`, `localhost:${f.proxyPort}`, `LOCALHOST:${f.proxyPort}`]) {
      assert.match(await rawRequest(f.proxyPort, ["POST /v1/responses HTTP/1.1", `Host: ${host}`, "Content-Length: 0"]), / 200 /, host);
    }
    assert.deepEqual(f.hits, ["Bearer token-a", "Bearer token-a", "Bearer token-a"]);
  } finally {
    f.close();
  }
});

test("Origin 헤더가 붙은 요청은 값과 관계없이 HTTP와 WebSocket 모두 거부한다", async () => {
  const f = await startGuardedProxy(19251);
  const host = `Host: 127.0.0.1:${f.proxyPort}`;
  try {
    // WebSocket은 CORS로 막히지 않으므로 Origin으로 거부해야 합니다. file://·sandbox 페이지는 null을 보냅니다.
    for (const origin of ["https://attacker.example", "http://127.0.0.1:8080", "null", "file://", "chrome-extension://abc", "app://codex", ""]) {
      assert.match(await rawRequest(f.proxyPort, ["GET /v1/responses HTTP/1.1", host, `Origin: ${origin}`, ...UPGRADE]), / 403 /, origin);
      assert.match(await rawRequest(f.proxyPort, ["POST /v1/responses HTTP/1.1", host, `Origin: ${origin}`, "Content-Length: 0"]), / 403 /, origin);
    }
    assert.deepEqual(f.hits, []);
    // Origin 없는 Codex WebSocket은 그대로 중계합니다.
    assert.match(await rawRequest(f.proxyPort, ["GET /v1/responses HTTP/1.1", host, ...UPGRADE]), / 101 /);
    assert.deepEqual(f.hits, ["Bearer token-a"]);
  } finally {
    f.close();
  }
});

test("Sec-Fetch-Site가 none이 아닌 요청은 Origin이 없어도 거부한다", async () => {
  const f = await startGuardedProxy(19261);
  const host = `Host: 127.0.0.1:${f.proxyPort}`;
  try {
    // <img>, no-cors fetch, 페이지 이동은 GET이라 Origin이 없고 Sec-Fetch-Site만 붙습니다.
    for (const site of ["cross-site", "same-site", "same-origin", "CROSS-SITE"]) {
      assert.match(await rawRequest(f.proxyPort, ["GET /v1/models HTTP/1.1", host, `Sec-Fetch-Site: ${site}`, "Sec-Fetch-Mode: no-cors"]), / 403 /, site);
    }
    assert.deepEqual(f.hits, []);
    // 사용자가 주소창에 직접 연 요청(none)과 Sec-Fetch-Site가 없는 요청은 그대로 중계합니다.
    // Node fetch(undici)는 Sec-Fetch-Mode만 보냅니다.
    assert.match(await rawRequest(f.proxyPort, ["GET /v1/models HTTP/1.1", host, "Sec-Fetch-Site: none"]), / 200 /);
    assert.match(await rawRequest(f.proxyPort, ["GET /v1/models HTTP/1.1", host, "Sec-Fetch-Mode: cors"]), / 200 /);
    assert.deepEqual(f.hits, ["Bearer token-a", "Bearer token-a"]);
  } finally {
    f.close();
  }
});

test("거부한 WebSocket 업그레이드에서 클라이언트가 먼저 끊어도 프록시가 죽지 않는다", async () => {
  const f = await startGuardedProxy(19271);
  try {
    // upgrade 소켓에는 Node 기본 error 리스너가 없어, 403을 쓰기 전에 RST가 오면 uncaught ECONNRESET이 납니다.
    await Promise.all(Array.from({ length: 40 }, () => new Promise((resolve) => {
      const socket = net.connect(f.proxyPort, "127.0.0.1", () => {
        socket.write(["GET /v1/responses HTTP/1.1", `Host: 127.0.0.1:${f.proxyPort}`, "Origin: https://attacker.example", ...UPGRADE, "", ""].join("\r\n"));
        setImmediate(() => socket.resetAndDestroy());
      });
      socket.on("error", () => {});
      socket.once("close", resolve);
    })));
    assert.match(await rawRequest(f.proxyPort, ["GET /v1/models HTTP/1.1", `Host: 127.0.0.1:${f.proxyPort}`]), / 200 /);
  } finally {
    f.close();
  }
});

test("Host는 설정 포트가 아니라 연결이 들어온 실제 포트와 비교한다", async () => {
  // port: 0으로 시작하면 운영체제가 고른 포트로 열립니다. 이때도 Codex 요청은 중계되어야 합니다.
  const f = await startGuardedProxy(0);
  const port = f.proxy.server.address().port;
  try {
    assert.match(await rawRequest(port, ["GET /v1/models HTTP/1.1", `Host: 127.0.0.1:${port}`]), / 200 /);
    assert.match(await rawRequest(port, ["GET /v1/models HTTP/1.1", `Host: 127.0.0.1:${port + 1}`]), / 403 /);
    assert.deepEqual(f.hits, ["Bearer token-a"]);
  } finally {
    f.close();
  }
});

test("거부 기록은 10초에 한 번만 남겨 로그가 계속 커지지 않는다", async () => {
  const lines = [];
  const proxy = new CodexProxy({
    upstreamBase: "http://127.0.0.1:9/backend-api/codex",
    port: 19281,
    resolveAccounts: async () => [],
    readAuth: () => null,
    log: (line) => lines.push(line),
  });
  const proxyPort = await proxy.start();
  try {
    for (let index = 0; index < 5; index += 1) {
      assert.match(await rawRequest(proxyPort, ["GET /v1/models HTTP/1.1", `Host: attacker.example:${proxyPort}`]), / 403 /);
    }
    assert.equal(lines.filter((line) => line.startsWith("proxy rejected")).length, 1);
  } finally {
    proxy.stop();
  }
});
