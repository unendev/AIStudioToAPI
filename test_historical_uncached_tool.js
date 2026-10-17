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

async function testClaudeHistoricalUncached() {
    console.log("----------------------------------------------------------------------");
    console.log("🧪 Test 1: Claude /v1/messages with UNCACHED Historical Tool Calls");
    console.log("   (Simulating a restarted server or continuing an existing Cline task)");
    console.log("----------------------------------------------------------------------");

    const tools = [
        {
            description: "Execute a terminal command",
            input_schema: {
                properties: { command: { type: "string" } },
                required: ["command"],
                type: "object",
            },
            name: "execute_command",
        },
    ];

    // Send a multi-turn history containing a historical tool_use and tool_result
    // that was NEVER in the current server's cache!
    const res = await postJson(
        "/v1/messages",
        {
            "anthropic-version": "2023-06-01",
            "x-api-key": "123456",
        },
        {
            max_tokens: 200,
            messages: [
                {
                    content: "Check the disk space on drive D.",
                    role: "user",
                },
                {
                    content: [
                        {
                            id: "call_historical_uncached_d_drive_99999",
                            input: { command: "Get-PSDrive D" },
                            name: "execute_command",
                            type: "tool_use",
                        },
                    ],
                    role: "assistant",
                },
                {
                    content: [
                        {
                            content: "Name: D, Used: 340GB, Free: 120GB, Provider: FileSystem",
                            tool_use_id: "call_historical_uncached_d_drive_99999",
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

    console.log(`Claude Response Status: ${res.status}`);
    if (res.status !== 200) {
        throw new Error(`Claude historical uncached test FAILED with status ${res.status}: ${res.raw}`);
    }
    const replyText = res.body.content?.map(c => c.text || `[${c.type}]`).join(" ");
    console.log(`Claude Reply Output: "${replyText}"`);
    console.log("✅ Claude Historical Uncached Tool Test: PASSED (HTTP 200 OK)");
}

async function testOpenAIHistoricalUncached() {
    console.log("\n----------------------------------------------------------------------");
    console.log("🧪 Test 2: OpenAI /v1/chat/completions with UNCACHED Historical Tool Calls");
    console.log("----------------------------------------------------------------------");

    const tools = [
        {
            function: {
                description: "Execute a terminal command",
                name: "execute_command",
                parameters: {
                    properties: { command: { type: "string" } },
                    required: ["command"],
                    type: "object",
                },
            },
            type: "function",
        },
    ];

    const res = await postJson(
        "/v1/chat/completions",
        {
            Authorization: "Bearer 123456",
        },
        {
            messages: [
                {
                    content: "Check the disk space on drive D.",
                    role: "user",
                },
                {
                    role: "assistant",
                    tool_calls: [
                        {
                            function: {
                                arguments: JSON.stringify({ command: "Get-PSDrive D" }),
                                name: "execute_command",
                            },
                            id: "call_openai_historical_uncached_88888",
                            type: "function",
                        },
                    ],
                },
                {
                    content: "Name: D, Used: 340GB, Free: 120GB, Provider: FileSystem",
                    role: "tool",
                    tool_call_id: "call_openai_historical_uncached_88888",
                },
            ],
            model: "gemini-flash-latest",
            tools,
        }
    );

    console.log(`OpenAI Response Status: ${res.status}`);
    if (res.status !== 200) {
        throw new Error(`OpenAI historical uncached test FAILED with status ${res.status}: ${res.raw}`);
    }
    const replyText =
        res.body.choices?.[0]?.message?.content || JSON.stringify(res.body.choices?.[0]?.message?.tool_calls);
    console.log(`OpenAI Reply Output: "${replyText}"`);
    console.log("✅ OpenAI Historical Uncached Tool Test: PASSED (HTTP 200 OK)");
}

async function main() {
    try {
        await testClaudeHistoricalUncached();
        await testOpenAIHistoricalUncached();
        console.log("\n======================================================================");
        console.log("🏆 ALL HISTORICAL UNCACHED TOOL TESTS PASSED! ZERO 400 ERRORS!");
        console.log("======================================================================");
    } catch (err) {
        console.error("\n❌ Historical Test Failed:", err);
        process.exit(1);
    }
}

main();
