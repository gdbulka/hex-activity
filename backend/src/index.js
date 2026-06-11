// hex-activity/backend/src/index.js
// Cloudflare Worker: игровое состояние в Upstash Redis + OAuth обмен токена Discord.

const BOARD_SIZE = 11; // Hex 11x11

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    const url = new URL(request.url);
    const path = url.pathname;

    // --- Upstash Redis REST helper ---
    const redis = async (...command) => {
      const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      });
      const out = await res.json();
      return out.result;
    };

    const newRoom = (roomId) => ({
      id: roomId,
      player1: null, // red — соединяет верх и низ
      player2: null, // blue — соединяет лево и право
      board: Array(BOARD_SIZE * BOARD_SIZE).fill(0),
      turn: "red",
      winner: null,
      moves: 0,
    });

    try {
      // === 0. OAuth: обмен code -> access_token (вызывается фронтендом) ===
      if (path === "/api/token" && request.method === "POST") {
        const { code } = await request.json();
        const body = new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
        });
        const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        const data = await tokenRes.json();
        if (!data.access_token) {
          return json({ error: "token_exchange_failed", detail: data }, 400);
        }
        return json({ access_token: data.access_token });
      }

      // === 1. join ===
      if (path === "/api/join" && request.method === "POST") {
        const { roomId, userId, username } = await request.json();
        const key = `room:${roomId}`;

        let raw = await redis("GET", key);
        let room = raw ? JSON.parse(raw) : newRoom(roomId);

        // Уже сидящий игрок — просто вернуть состояние
        const already =
          (room.player1 && room.player1.id === userId) ||
          (room.player2 && room.player2.id === userId);

        if (!already) {
          if (!room.player1) {
            room.player1 = { id: userId, name: username, color: "red" };
          } else if (!room.player2) {
            room.player2 = { id: userId, name: username, color: "blue" };
          }
          // если оба заняты — заходит как зритель (не пишется в игроки)
        }

        await redis("SET", key, JSON.stringify(room));
        return json(room);
      }

      // === 2. state (polling) ===
      if (path === "/api/state" && request.method === "GET") {
        const roomId = url.searchParams.get("roomId");
        const raw = await redis("GET", `room:${roomId}`);
        if (!raw) return json({ error: "room_not_found" }, 404);
        return json(JSON.parse(raw));
      }

      // === 3. move ===
      if (path === "/api/move" && request.method === "POST") {
        const { roomId, userId, cellIndex } = await request.json();
        const key = `room:${roomId}`;

        const raw = await redis("GET", key);
        if (!raw) return json({ error: "room_not_found" }, 404);
        const room = JSON.parse(raw);

        const isP1 = room.player1 && room.player1.id === userId;
        const isP2 = room.player2 && room.player2.id === userId;
        const color = isP1 ? "red" : isP2 ? "blue" : null;

        if (
          !color ||
          room.winner ||
          room.turn !== color ||
          cellIndex < 0 ||
          cellIndex >= BOARD_SIZE * BOARD_SIZE ||
          room.board[cellIndex] !== 0
        ) {
          return json({ error: "invalid_move" }, 400);
        }

        room.board[cellIndex] = color === "red" ? 1 : 2;
        room.moves += 1;

        if (checkWin(room.board, color === "red" ? 1 : 2)) {
          room.winner = color;
        } else {
          room.turn = color === "red" ? "blue" : "red";
        }

        await redis("SET", key, JSON.stringify(room));
        return json(room);
      }

      // === 4. reset ===
      if (path === "/api/reset" && request.method === "POST") {
        const { roomId, userId } = await request.json();
        const key = `room:${roomId}`;
        const raw = await redis("GET", key);
        const room = raw ? JSON.parse(raw) : newRoom(roomId);

        // сбрасываем доску, игроков сохраняем
        room.board = Array(BOARD_SIZE * BOARD_SIZE).fill(0);
        room.turn = "red";
        room.winner = null;
        room.moves = 0;

        await redis("SET", key, JSON.stringify(room));
        return json(room);
      }

      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "server_error", detail: String(e) }, 500);
    }
  },
};

// --- Проверка победы через BFS ---
// red (1): соединить верхний ряд (row 0) с нижним (row N-1)
// blue (2): соединить левый столбец (col 0) с правым (col N-1)
// Соседство в Hex: 6 направлений на ромбической сетке.
function checkWin(board, player) {
  const N = BOARD_SIZE;
  const idx = (r, c) => r * N + c;
  const dirs = [
    [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, -1], [1, 0],
  ];

  const visited = new Set();
  const queue = [];

  // стартовая грань
  for (let i = 0; i < N; i++) {
    const r = player === 1 ? 0 : i;
    const c = player === 1 ? i : 0;
    if (board[idx(r, c)] === player) {
      queue.push([r, c]);
      visited.add(idx(r, c));
    }
  }

  while (queue.length) {
    const [r, c] = queue.shift();
    // достигли противоположной грани?
    if (player === 1 && r === N - 1) return true;
    if (player === 2 && c === N - 1) return true;

    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue;
      const ni = idx(nr, nc);
      if (visited.has(ni)) continue;
      if (board[ni] === player) {
        visited.add(ni);
        queue.push([nr, nc]);
      }
    }
  }
  return false;
}
