const http = require("http");

function postJson(path, headers, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(
            {
                headers: {
                    "Content-Length": Buffer.byteLength(payload),
                    "Content-Type": "application/json",
                    ...headers,
                },
                hostname: "127.0.0.1",
                method: "POST",
                path,
                port: 7860,
            },
            res => {
                let data = "";
                res.on("data", chunk => (data += chunk.toString()));
                res.on("end", () => {
                    try {
                        resolve({ body: JSON.parse(data), raw: data, status: res.statusCode });
                    } catch (_) {
                        resolve({ body: null, raw: data, status: res.statusCode });
                    }
                });
            }
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

async function testClaudeMultiTurn() {
    console.log("----------------------------------------------------");
    console.log("🧪 Testing Claude /v1/messages Multi-Turn Tool Flow");
    console.log("----------------------------------------------------");

    const tools = [
        {
            description: "Get current weather for a city",
            input_schema: {
                properties: { city: { type: "string" } },
                required: ["city"],
                type: "object",
            },
            name: "get_weather",
        },
    ];

    // Turn 1: Trigger tool call
    console.log("Turn 1: Requesting model to call tool...");
    const res1 = await postJson(
        "/v1/messages",
        {
            "anthropic-version": "2023-06-01",
            "x-api-key": "123456",
        },
        {
            max_tokens: 150,
            messages: [{ content: "What is the weather in Tokyo? You MUST use the get_weather tool.", role: "user" }],
            model: "gemini-flash-latest",
            tools,
        }
    );

    console.log(`Turn 1 Status: ${res1.status}`);
    if (res1.status !== 200) {
        throw new Error(`Turn 1 failed: ${res1.raw}`);
    }

    const toolBlock = res1.body.content?.find(b => b.type === "tool_use");
    if (!toolBlock) {
        throw new Error(`Turn 1 did not return a tool_use block: ${JSON.stringify(res1.body)}`);
    }
    console.log(`Turn 1 Tool Call Generated: ${toolBlock.name} (id: ${toolBlock.id})`);

    // Turn 2: Simulate client returning tool result (stripping any non-standard fields like real clients do)
    console.log("\nTurn 2: Submitting tool result in history (client stripped signatures)...");
    const cleanToolUse = {
        id: toolBlock.id,
        input: toolBlock.input,
        name: toolBlock.name,
        type: "tool_use",
    };

    const res2 = await postJson(
        "/v1/messages",
        {
            "anthropic-version": "2023-06-01",
            "x-api-key": "123456",
        },
        {
            max_tokens: 150,
            messages: [
                { content: "What is the weather in Tokyo? You MUST use the get_weather tool.", role: "user" },
                { content: [cleanToolUse], role: "assistant" },
                {
                    content: [
                        {
                            content: "The weather in Tokyo is Sunny, 21 degrees Celsius.",
                            tool_use_id: toolBlock.id,
                            type: "tool_result",
                        },
                    ],
                    role: "user",
                },
            ],
            model: "gemini-flash-latest",
            tools,
        }
    );

    console.log(`Turn 2 Status: ${res2.status}`);
    if (res2.status !== 200) {
        throw new Error(`Turn 2 failed: ${res2.raw}`);
    }
    const finalText = res2.body.content?.find(b => b.type === "text")?.text;
    console.log(`Turn 2 Model Output: "${finalText}"`);
    console.log("✅ Claude Multi-Turn Tool Flow PASSED!");
}

async function testOpenAIMultiTurn() {
    console.log("\n----------------------------------------------------");
    console.log("🧪 Testing OpenAI /v1/chat/completions Multi-Turn Tool Flow");
    console.log("----------------------------------------------------");

    const tools = [
        {
            function: {
                description: "Get current weather for a city",
                name: "get_weather",
                parameters: {
                    properties: { city: { type: "string" } },
                    required: ["city"],
                    type: "object",
                },
            },
            type: "function",
        },
    ];

    // Turn 1: Trigger tool call
    console.log("Turn 1: Requesting model to call tool...");
    const res1 = await postJson(
        "/v1/chat/completions",
        {
            Authorization: "Bearer 123456",
        },
        {
            messages: [
                { content: "What is the weather in Tokyo? You MUST use the get_weather function.", role: "user" },
            ],
            model: "gemini-flash-latest",
            tools,
        }
    );

    console.log(`Turn 1 Status: ${res1.status}`);
    if (res1.status !== 200) {
        throw new Error(`Turn 1 failed: ${res1.raw}`);
    }

    const toolCall = res1.body.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
        throw new Error(`Turn 1 did not return tool_calls: ${JSON.stringify(res1.body)}`);
    }
    console.log(`Turn 1 Tool Call Generated: ${toolCall.function?.name} (id: ${toolCall.id})`);

    // Turn 2: Simulate client returning tool result (standard OpenAI format, no signatures)
    console.log("\nTurn 2: Submitting tool result in history (standard OpenAI format)...");
    const cleanAssistantMessage = {
        role: "assistant",
        tool_calls: [
            {
                function: {
                    arguments: toolCall.function.arguments,
                    name: toolCall.function.name,
                },
                id: toolCall.id,
                type: "function",
            },
        ],
    };

    const res2 = await postJson(
        "/v1/chat/completions",
        {
            Authorization: "Bearer 123456",
        },
        {
            messages: [
                { content: "What is the weather in Tokyo? You MUST use the get_weather function.", role: "user" },
                cleanAssistantMessage,
                {
                    content: "The weather in Tokyo is Sunny, 21 degrees Celsius.",
                    role: "tool",
                    tool_call_id: toolCall.id,
                },
            ],
            model: "gemini-flash-latest",
            tools,
        }
    );

    console.log(`Turn 2 Status: ${res2.status}`);
    if (res2.status !== 200) {
        throw new Error(`Turn 2 failed: ${res2.raw}`);
    }
    const finalText = res2.body.choices?.[0]?.message?.content;
    console.log(`Turn 2 Model Output: "${finalText}"`);
    console.log("✅ OpenAI Multi-Turn Tool Flow PASSED!");
}

async function main() {
    try {
        await testClaudeMultiTurn();
        await testOpenAIMultiTurn();
        console.log("\n====================================================");
        console.log("🎉 ALL MULTI-TURN TOOL CALL GATES PASSED (100% OK)");
        console.log("====================================================");
    } catch (err) {
        console.error("\n❌ Multi-Turn Test Failed:", err);
        process.exit(1);
    }
}

main();
