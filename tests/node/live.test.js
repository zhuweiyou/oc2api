import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import vercelApp from "../../api/index.js";
import { startServer } from "../../server/index.js";

const live = process.env.OC2API_LIVE_TEST === "1";

class LiveUnavailable extends Error {}

test("real big-pickle hi scenarios through local and Vercel entries", { skip: !live }, async (t) => {
	const localServer = startServer({ port: 0, logger: { log() {} } });
	await once(localServer, "listening");

	const vercelServer = createServer(vercelApp);
	vercelServer.listen(0, "127.0.0.1");
	await once(vercelServer, "listening");

	t.after(async () => {
		await close(localServer);
		await close(vercelServer);
	});

	try {
		await runScenarios(t, `http://127.0.0.1:${localServer.address().port}`, "local");
		await runScenarios(t, `http://127.0.0.1:${vercelServer.address().port}`, "vercel");
	} catch (error) {
		if (error instanceof LiveUnavailable) {
			t.skip(error.message);
			return;
		}
		throw error;
	}
});

async function runScenarios(t, baseURL, entryName) {
	const first = await requestChat(baseURL, {
		stream: false,
		messages: [{ role: "user", content: "hi" }],
	});
	const firstJSON = parseJSON(first.text, `${entryName} non-stream hi`);
	const firstContent = extractAssistantContent(firstJSON) || "hi";
	t.diagnostic(`${entryName}: non-stream hi passed`);

	const streamed = await requestChat(baseURL, {
		stream: true,
		messages: [{ role: "user", content: "hi" }],
	});
	assert.match(streamed.text, /data:/, `${entryName} stream should contain SSE data`);
	assert.match(streamed.text, /\[DONE\]/, `${entryName} stream should terminate with [DONE]`);
	assert.ok(parseSSEData(streamed.text).length > 0, `${entryName} stream should contain a JSON chunk`);
	t.diagnostic(`${entryName}: stream hi passed`);

	const tools = await requestChat(baseURL, {
		stream: false,
		messages: [{ role: "user", content: "hi" }],
		tools: [weatherTool()],
		tool_choice: "none",
	});
	const toolsJSON = parseJSON(tools.text, `${entryName} custom tools`);
	assert.ok(Array.isArray(toolsJSON.choices) && toolsJSON.choices.length > 0, `${entryName} tools response has no choices`);
	t.diagnostic(`${entryName}: custom tools passed`);

	const conversation = await requestChat(baseURL, {
		stream: false,
		messages: [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: firstContent },
			{ role: "user", content: "reply briefly with hi again" },
		],
	});
	const conversationJSON = parseJSON(conversation.text, `${entryName} continuous conversation`);
	assert.ok(Array.isArray(conversationJSON.choices) && conversationJSON.choices.length > 0, `${entryName} conversation has no choices`);
	t.diagnostic(`${entryName}: continuous conversation passed`);
}

async function requestChat(baseURL, payload) {
	const headers = { "content-type": "application/json" };
	if (process.env.API_KEY) headers.authorization = `Bearer ${process.env.API_KEY}`;

	const response = await fetch(`${baseURL}/v1/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify({ model: "big-pickle", max_tokens: 64, temperature: 0, ...payload }),
	});
	const text = await response.text();
	if (response.status === 429) {
		throw new LiveUnavailable(`big-pickle upstream is rate limited: ${text.trim()}`);
	}
	assert.equal(response.status, 200, `big-pickle request failed with HTTP ${response.status}: ${text}`);
	return { headers: response.headers, text };
}

function parseJSON(text, scenario) {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${scenario} returned invalid JSON: ${error.message}; body=${text}`);
	}
}

function parseSSEData(text) {
	return text
		.split(/\r?\n\r?\n/)
		.map((event) => event.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim())
		.filter((payload) => payload && payload !== "[DONE]")
		.map((payload) => parseJSON(payload, "stream event"));
}

function extractAssistantContent(response) {
	return response?.choices?.[0]?.message?.content || "";
}

function weatherTool() {
	return {
		type: "function",
		function: {
			name: "get_weather",
			description: "Get the weather for a city.",
			parameters: {
				type: "object",
				properties: { city: { type: "string" } },
				required: ["city"],
				additionalProperties: false,
			},
		},
	};
}

async function close(server) {
	if (!server.listening) return;
	server.close();
	await once(server, "close");
}
