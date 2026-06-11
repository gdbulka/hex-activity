// hex-activity/backend/src/index.js

export default {
  async fetch(request, env) {
    // Настройка CORS, чтобы фронтенд с Cloudflare Pages мог делать запросы
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Helper для запросов к Upstash Redis REST API
    const redisFetch = async (command, ...args) => {
      const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([command, ...args]),
      });
      const result = await response.json();
      return result.result;
    };

    // 1. Подключение к комнате (или создание новой)
    if (path === "/api/join" && request.method === "POST") {
      const { roomId, userId, username } = await request.json();
      const roomKey = `room:${roomId}`;

      let room = await redisFetch("GET", roomKey);
      
      if (!room) {
        // Создаем новую комнату, если её нет
        room = {
          id: roomId,
          player1: { id: userId, name: username, color: "red" },
          player2: null,
          board: Array(11 * 11).fill(0), // 0 - пусто, 1 - красный, 2 - синий
          turn: "red", // первый ход за красными
          winner: null
        };
      } else {
        room = JSON.parse(room);
        // Если заходит второй игрок, и это не первый игрок
        if (!room.player2 && room.player1.id !== userId) {
          room.player2 = { id: userId, name: username, color: "blue" };
        }
      }

      await redisFetch("SET", roomKey, JSON.stringify(room));
      return new Response(JSON.stringify(room), { headers: corsHeaders });
    }

    // 2. Получение текущего состояния комнаты (Polling)
    if (path === "/api/state" && request.method === "GET") {
      const roomId = url.searchParams.get("roomId");
      const room = await redisFetch("GET", `room:${roomId}`);
      return new Response(room || JSON.stringify({ error: "Room not found" }), { headers: corsHeaders });
    }

    // 3. Обработка хода
    if (path === "/api/move" && request.method === "POST") {
      const { roomId, userId, cellIndex } = await request.json();
      const roomKey = `room:${roomId}`;
      
      let room = await redisFetch("GET", roomKey);
      if (!room) return new Response("Room not found", { status: 404, headers: corsHeaders });
      
      room = JSON.parse(room);

      // Проверки: игра идет, ход игрока, ячейка пуста
      const isPlayer1 = room.player1 && room.player1.id === userId;
      const isPlayer2 = room.player2 && room.player2.id === userId;
      const currentPlayerColor = isPlayer1 ? "red" : (isPlayer2 ? "blue" : null);

      if (!currentPlayerColor || room.turn !== currentPlayerColor || room.board[cellIndex] !== 0 || room.winner) {
        return new Response(JSON.stringify({ error: "Invalid move" }), { status: 400, headers: corsHeaders });
      }

      // Делаем ход
      room.board[cellIndex] = currentPlayerColor === "red" ? 1 : 2;
      
      // Проверяем победу (упрощенно переключаем ход, алгоритм победы ниже)
      // Для полноценного HEX тут должен быть поиск в ширину/глубину (BFS/DFS)
      room.turn = currentPlayerColor === "red" ? "blue" : "red";

      await redisFetch("SET", roomKey, JSON.stringify(room));
      return new Response(JSON.stringify(room), { headers: corsHeaders });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};