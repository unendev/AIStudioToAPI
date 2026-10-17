/**
 * File: src/core/FormatConverter/CommonConverter.js
 * Description: Shared converter context, model suffixes, Gemini tools/schemas, media loading, and usage parsing.
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const axios = require("axios");
const mime = require("mime-types");

class FormatConverter {
    static CLAUDE_CODE_EXECUTION_TOOL_TYPES = new Set([
        "code_execution_20250825",
        "code_execution_20260120",
        "code_execution_20260521",
    ]);

    // Placeholder signature for Gemini 3 functionCall validation
    static DUMMY_THOUGHT_SIGNATURE = "context_engineering_is_the_way_to_go";

    // In-memory cache for tool call thoughtSignatures across conversation turns
    static toolSignatureCache = new Map();
    static MAX_TOOL_SIGNATURE_CACHE_SIZE = 2000;

    /**
     * Record a tool call thoughtSignature in cache
     * @param {string} id - Tool call ID
     * @param {string} signature - Gemini thoughtSignature
     * @param {string} [fallbackKey] - Optional fallback key (e.g. name:args)
     */
    static recordToolSignature(id, signature, fallbackKey = null) {
        if (!signature || typeof signature !== "string") return;
        if (FormatConverter.toolSignatureCache.size >= FormatConverter.MAX_TOOL_SIGNATURE_CACHE_SIZE) {
            const firstKey = FormatConverter.toolSignatureCache.keys().next().value;
            FormatConverter.toolSignatureCache.delete(firstKey);
        }
        if (id) {
            FormatConverter.toolSignatureCache.set(String(id), signature);
        }
        if (fallbackKey) {
            FormatConverter.toolSignatureCache.set(String(fallbackKey), signature);
        }
    }

    /**
     * Retrieve a cached tool call thoughtSignature
     * @param {string} id - Tool call ID
     * @param {string} [fallbackKey] - Optional fallback key (e.g. name:args)
     * @returns {string|null} - Cached signature or null
     */
    static getToolSignature(id, fallbackKey = null) {
        if (id && FormatConverter.toolSignatureCache.has(String(id))) {
            return FormatConverter.toolSignatureCache.get(String(id));
        }
        if (fallbackKey && FormatConverter.toolSignatureCache.has(String(fallbackKey))) {
            return FormatConverter.toolSignatureCache.get(String(fallbackKey));
        }
        return null;
    }
    static GEMINI_BUILT_IN_TOOL_KEYS = [
        "codeExecution",
        "code_execution",
        "googleMaps",
        "google_maps",
        "googleSearch",
        "google_search",
        "googleSearchRetrieval",
        "google_search_retrieval",
        "urlContext",
        "url_context",
    ];

    // ThinkingLevel suffix mapping (lowercase -> uppercase API value)
    static THINKING_LEVEL_MAP = {
        high: "HIGH",
        low: "LOW",
        medium: "MEDIUM",
        minimal: "MINIMAL",
    };

    /**
     * Parse web search suffix from model name.
     * Only supports the LAST hyphen token: `-search` (case-insensitive).
     *
     * Examples:
     * - gemini-3-flash-preview-minimal-search -> { cleanModelName: "gemini-3-flash-preview-minimal", forceWebSearch: true }
     * - gemini-3-flash-preview-search-minimal -> no match (search suffix must be last)
     *
     * @param {string} modelName - Original model name
     * @returns {{ cleanModelName: string, forceWebSearch: boolean }}
     */
    static parseModelWebSearchSuffix(modelName) {
        if (!modelName || typeof modelName !== "string") {
            return { cleanModelName: modelName, forceWebSearch: false };
        }

        const match = modelName.match(/^(.+)-search$/i);
        if (!match) {
            return { cleanModelName: modelName, forceWebSearch: false };
        }

        return { cleanModelName: match[1], forceWebSearch: true };
    }

    /**
     * Parse trailing built-in tool suffixes from model name.
     * Tool suffixes may be chained at the end of the model name, for example:
     * `gemini-3-flash-preview-minimal-search-code`.
     *
     * @param {string} modelName - Original model name
     * @returns {{ cleanModelName: string, forceWebSearch: boolean, forceCodeExecution: boolean }}
     */
    static parseModelBuiltInToolSuffixes(modelName) {
        if (!modelName || typeof modelName !== "string") {
            return {
                cleanModelName: modelName,
                forceCodeExecution: false,
                forceWebSearch: false,
            };
        }

        let cleanModelName = modelName;
        let forceCodeExecution = false;
        let forceWebSearch = false;

        let match = cleanModelName.match(/^(.+)-(search|code)$/i);
        while (match) {
            cleanModelName = match[1];
            const suffix = match[2].toLowerCase();
            if (suffix === "code") {
                forceCodeExecution = true;
            } else {
                forceWebSearch = true;
            }
            match = cleanModelName.match(/^(.+)-(search|code)$/i);
        }

        return { cleanModelName, forceCodeExecution, forceWebSearch };
    }

    /**
     * Parse streaming mode suffix from model name.
     * Only matches a trailing `-real` or `-fake` (case-insensitive).
     * Callers should strip trailing built-in tool suffixes before invoking this helper, so the
     * combined suffix order remains: thinking -> streaming -> built-in tools.
     *
     * Examples:
     * - gemini-3-flash-preview-minimal-fake -> { cleanModelName: "gemini-3-flash-preview-minimal", streamingMode: "fake" }
     * - gemini-3-flash-preview(minimal)-fake -> { cleanModelName: "gemini-3-flash-preview(minimal)", streamingMode: "fake" }
     * - gemini-3-flash-preview-fake-minimal -> no match (thinking must come before streaming)
     * - gemini-3-flash-preview(minimal)-fake-search-code -> no direct match here; callers strip tool suffixes first
     *
     * @param {string} modelName - Original model name
     * @returns {{ cleanModelName: string, streamingMode: ("real"|"fake"|null) }}
     */
    static parseModelStreamingModeSuffix(modelName) {
        if (!modelName || typeof modelName !== "string") {
            return { cleanModelName: modelName, streamingMode: null };
        }

        const match = modelName.match(/^(.+)-(real|fake)$/i);
        if (!match) {
            return { cleanModelName: modelName, streamingMode: null };
        }

        return { cleanModelName: match[1], streamingMode: match[2].toLowerCase() };
    }

    /**
     * Parse thinkingLevel suffix from model name
     * Supports two formats:
     *   - Parenthesis format: gemini-3-flash-preview(minimal), gemini-3-pro-preview(high)
     *   - Hyphen format: gemini-3-flash-preview-minimal, gemini-3-pro-preview-high
     *
     * @param {string} modelName - Original model name
     * @returns {{ cleanModelName: string, thinkingLevel: string|null }}
     *          - cleanModelName: Model name with suffix removed
     *          - thinkingLevel: Uppercase thinkingLevel value, or null if no suffix
     */
    static parseModelThinkingLevel(modelName) {
        if (!modelName || typeof modelName !== "string") {
            return { cleanModelName: modelName, thinkingLevel: null };
        }

        const levels = Object.keys(FormatConverter.THINKING_LEVEL_MAP);

        // Check parenthesis format: model(level)
        const parenMatch = modelName.match(new RegExp(`^(.+)\\((${levels.join("|")})\\)$`, "i"));
        if (parenMatch) {
            const baseModel = parenMatch[1];
            const levelKey = parenMatch[2].toLowerCase();
            return {
                cleanModelName: baseModel,
                thinkingLevel: FormatConverter.THINKING_LEVEL_MAP[levelKey],
            };
        }

        // Check hyphen format: model-level
        const hyphenMatch = modelName.match(new RegExp(`^(.+)-(${levels.join("|")})$`, "i"));
        if (hyphenMatch) {
            const baseModel = hyphenMatch[1];
            const levelKey = hyphenMatch[2].toLowerCase();
            return {
                cleanModelName: baseModel,
                thinkingLevel: FormatConverter.THINKING_LEVEL_MAP[levelKey],
            };
        }

        // No matching suffix
        return { cleanModelName: modelName, thinkingLevel: null };
    }

    /**
     * Parse all supported model-name suffixes in their required stripping order
     * and log any detected overrides.
     *
     * @param {string} modelName - Original model name
     * @param {{ logPrefix?: string, modelSource?: string }} [options] - Log message context
     * @returns {{
     *   cleanModelName: string,
     *   forceCodeExecution: boolean,
     *   forceWebSearch: boolean,
     *   streamingMode: ("real"|"fake"|null),
     *   thinkingLevel: string|null
     * }} Parsed model name and overrides
     */
    parseModelSuffixes(modelName, { logPrefix = "[Adapter]", modelSource = "model name" } = {}) {
        const {
            cleanModelName: toolStrippedModel,
            forceCodeExecution,
            forceWebSearch,
        } = FormatConverter.parseModelBuiltInToolSuffixes(modelName);
        const { cleanModelName: streamStrippedModel, streamingMode } =
            FormatConverter.parseModelStreamingModeSuffix(toolStrippedModel);
        const { cleanModelName, thinkingLevel } = FormatConverter.parseModelThinkingLevel(streamStrippedModel);

        const forceToolFlags = [];
        if (forceWebSearch) forceToolFlags.push("forceWebSearch=true");
        if (forceCodeExecution) forceToolFlags.push("forceCodeExecution=true");
        if (forceToolFlags.length > 0) {
            this.logger.info(
                `${logPrefix} Detected built-in tool suffixes in ${modelSource}: "${modelName}" -> model="${toolStrippedModel}", ${forceToolFlags.join(", ")}`
            );
        }
        if (streamingMode) {
            this.logger.info(
                `${logPrefix} Detected streamingMode suffix in ${modelSource}: "${toolStrippedModel}" -> model="${streamStrippedModel}", streamingMode="${streamingMode}"`
            );
        }
        if (thinkingLevel) {
            this.logger.info(
                `${logPrefix} Detected thinkingLevel suffix in ${modelSource}: "${streamStrippedModel}" -> model="${cleanModelName}", thinkingLevel="${thinkingLevel}"`
            );
        }

        const MODEL_ALIASES = {
            auto: "gemini-flash-latest",
            "gemini-3.5-flash": "gemini-flash-latest",
            "gemini-3.5-pro": "gemini-pro-latest",
            "gemini-3.8-flash": "gemini-flash-latest",
            "gemini-3.8-pro": "gemini-pro-latest",
        };
        const resolvedModelName = MODEL_ALIASES[cleanModelName] || cleanModelName;
        if (resolvedModelName !== cleanModelName) {
            this.logger.info(`${logPrefix} Model alias normalized: "${cleanModelName}" -> "${resolvedModelName}"`);
        }

        return {
            cleanModelName: resolvedModelName,
            forceCodeExecution,
            forceWebSearch,
            streamingMode,
            thinkingLevel,
        };
    }

    constructor(logger, serverSystem) {
        this.logger = logger;
        this.serverSystem = serverSystem;
    }

    /**
     * Accumulate Gemini content parts for one role and append them as a single
     * content turn when flushed.
     *
     * @param {Array<object>} contents - Target Gemini contents array
     * @param {"model"|"user"} role - Role assigned to flushed content
     * @returns {{
     *   readonly length: number,
     *   flush: () => void,
     *   push: (...parts: object[]) => number,
     *   some: (predicate: (part: object) => boolean) => boolean
     * }} Mutable content-parts buffer
     * @protected
     */
    _createGoogleContentPartsBuffer(contents, role) {
        let parts = [];
        return {
            flush() {
                if (parts.length === 0) return;
                contents.push({ parts, role });
                parts = [];
            },
            get length() {
                return parts.length;
            },
            push(...newParts) {
                return parts.push(...newParts);
            },
            some(predicate) {
                return parts.some(predicate);
            },
        };
    }

    /**
     * Apply the model-name thinking level override and attach the resulting
     * thinking config to a Gemini generation config.
     *
     * @param {object} generationConfig - Gemini generation config
     * @param {object|null} thinkingConfig - Previously resolved thinking config
     * @param {string|null} modelThinkingLevel - Model suffix override
     * @protected
     */
    _applyThinkingConfig(generationConfig, thinkingConfig, modelThinkingLevel) {
        if (modelThinkingLevel) {
            if (!thinkingConfig) thinkingConfig = {};
            thinkingConfig.thinkingLevel = modelThinkingLevel;
        }

        if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
    }

    getDefaultSafetySettings() {
        let threshold = this.serverSystem?.config?.safetySettingsThreshold || "BLOCK_ONLY_HIGH";
        if (threshold === "OFF" || threshold === "BLOCK_NONE") {
            // Google Generative Language API rejects BLOCK_NONE and OFF with 400 INVALID_ARGUMENT
            // on standard/free accounts. BLOCK_ONLY_HIGH is the least restrictive threshold universally permitted.
            threshold = "BLOCK_ONLY_HIGH";
        }
        return [
            { category: "HARM_CATEGORY_HARASSMENT", threshold },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold },
        ];
    }

    normalizeImageUrl(imageSource) {
        if (typeof imageSource === "string") {
            return imageSource;
        }

        if (imageSource && typeof imageSource.url === "string") {
            return imageSource.url;
        }

        return null;
    }

    _getGeminiPromptBlockMessage(promptFeedback) {
        const reason = promptFeedback?.blockReason;
        if (typeof reason !== "string" || !reason || reason === "BLOCK_REASON_UNSPECIFIED") return null;
        const detail = promptFeedback.blockReasonMessage;
        return `Gemini blocked the request (${reason}).${typeof detail === "string" && detail ? ` ${detail}` : ""}`;
    }

    // Shared media loading for Responses outputs and Claude images/documents.
    async _loadFunctionResponseMedia(contentPart, itemIndex, { functionResponse = true } = {}) {
        const supportedMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain"]);
        const isImage = contentPart?.type === "input_image" || contentPart?.type === "image";
        const claudeSource = ["image", "document"].includes(contentPart?.type) ? contentPart.source : null;
        const source = claudeSource
            ? claudeSource.url
            : isImage
              ? this.normalizeImageUrl(contentPart.image_url)
              : contentPart?.file_data || contentPart?.file_url;

        let data;
        let mimeType;
        if (claudeSource?.type === "base64" || claudeSource?.type === "text") {
            if (typeof claudeSource.data !== "string" || !claudeSource.data) {
                this.logger.warn("[Adapter] Skipping Claude media with no data.");
                return null;
            }
            data =
                claudeSource.type === "text"
                    ? Buffer.from(claudeSource.data, "utf8").toString("base64")
                    : claudeSource.data;
            mimeType = claudeSource.media_type;
        } else if (typeof source !== "string" || !source) {
            this.logger.warn(
                `[Adapter] Skipping ${contentPart?.type || "unknown"} media because it has no supported data source.`
            );
            return null;
        } else if (source.startsWith("data:")) {
            const match = source.match(/^data:([^;,]+);base64,(.+)$/s);
            if (!match) {
                this.logger.warn("[Adapter] Skipping malformed media data URL.");
                return null;
            }
            [, mimeType, data] = match;
        } else if (/^https?:\/\//.test(source)) {
            try {
                const response = await axios.get(source, { responseType: "arraybuffer" });
                data = Buffer.from(response.data, "binary").toString("base64");
                mimeType = response.headers["content-type"]?.split(";", 1)[0];
                if (!mimeType || mimeType === "application/octet-stream") {
                    mimeType = mime.lookup(contentPart.filename || source) || undefined;
                }
            } catch (error) {
                this.logger.warn(`[Adapter] Failed to download media from ${source}: ${error.message}`);
                return null;
            }
        } else if (!claudeSource && !isImage && contentPart.file_data) {
            data = contentPart.file_data;
            mimeType = mime.lookup(contentPart.filename || "") || "application/octet-stream";
        } else {
            this.logger.warn("[Adapter] Skipping unsupported media URL.");
            return null;
        }

        if (!data) {
            this.logger.warn("[Adapter] Skipping empty media data.");
            return null;
        }
        if (!mimeType || (functionResponse && !supportedMimeTypes.has(mimeType))) {
            this.logger.warn(`[Adapter] Skipping media with unsupported MIME type: ${mimeType || "unknown"}`);
            return null;
        }

        const extension = mime.extension(mimeType);
        // Reference names are unique by output position; callers preserve original filenames/metadata.
        const displayName = `function-output-${itemIndex + 1}${extension ? `.${extension}` : ""}`;
        return { displayName, part: { inlineData: { data, displayName, mimeType } } };
    }

    /**
     * Ensure thoughtSignature is present in Gemini native format requests.
     * For historical functionCalls lacking a valid signature, degrade them and their
     * matching functionResponses to conversational text context to avoid Google 400 rejection.
     * @param {object} geminiBody - Gemini API request body
     * @returns {object} - Modified request body
     */
    ensureThoughtSignature(geminiBody) {
        if (!geminiBody || !geminiBody.contents || !Array.isArray(geminiBody.contents)) {
            return geminiBody;
        }

        const DUMMY_SIGNATURE = FormatConverter.DUMMY_THOUGHT_SIGNATURE;
        const degradedToolNames = new Set();

        for (const content of geminiBody.contents) {
            if (!content.parts || !Array.isArray(content.parts)) continue;

            for (let i = 0; i < content.parts.length; i++) {
                const part = content.parts[i];
                if (part.functionCall) {
                    if (!part.thoughtSignature) {
                        const fallbackKey = `${part.functionCall.name}:${JSON.stringify(part.functionCall.args || {})}`;
                        const cachedSig = FormatConverter.getToolSignature(part.functionCall.id, fallbackKey);
                        if (cachedSig) {
                            part.thoughtSignature = cachedSig;
                            this.logger.debug(
                                `[Adapter] Restored cached thoughtSignature for functionCall: ${part.functionCall.name}`
                            );
                        } else {
                            // Uncached historical tool call without thoughtSignature: degrade to text
                            this.logger.warn(
                                `[Adapter] Native Gemini functionCall "${part.functionCall.name}" has no thoughtSignature and none cached. Degrading to text context.`
                            );
                            const callName = part.functionCall.name;
                            const callId = part.functionCall.id;
                            if (callName) degradedToolNames.add(callName);
                            if (callId) degradedToolNames.add(callId);
                            content.parts[i] = {
                                text: `[Tool Call: ${callName}(${JSON.stringify(part.functionCall.args || {})})]`,
                            };
                            continue;
                        }
                    }
                    // Strip dummy/placeholder signatures to prevent Google API 400 INVALID_ARGUMENT rejection
                    if (part.thoughtSignature === DUMMY_SIGNATURE) {
                        delete part.thoughtSignature;
                    }
                } else if (part.functionResponse) {
                    const respName = part.functionResponse.name;
                    const respId = part.functionResponse.id;
                    if ((respName && degradedToolNames.has(respName)) || (respId && degradedToolNames.has(respId))) {
                        this.logger.warn(
                            `[Adapter] Native Gemini functionResponse "${respName}" matches degraded functionCall. Degrading to text context.`
                        );
                        content.parts[i] = {
                            text: `[Tool Result for ${respName}: ${JSON.stringify(part.functionResponse.response || {})}]`,
                        };
                    }
                }
            }
        }

        return geminiBody;
    }

    hasGeminiBuiltInTools(geminiBody) {
        return !!(
            geminiBody &&
            Array.isArray(geminiBody.tools) &&
            geminiBody.tools.some(
                tool =>
                    tool &&
                    typeof tool === "object" &&
                    FormatConverter.GEMINI_BUILT_IN_TOOL_KEYS.some(toolKey =>
                        Object.prototype.hasOwnProperty.call(tool, toolKey)
                    )
            )
        );
    }

    static hasGeminiToolKey(tool, keys) {
        return !!(
            tool &&
            typeof tool === "object" &&
            keys.some(toolKey => Object.prototype.hasOwnProperty.call(tool, toolKey))
        );
    }

    static hasGeminiGoogleSearchTool(tools) {
        return (
            Array.isArray(tools) &&
            tools.some(tool => FormatConverter.hasGeminiToolKey(tool, ["googleSearch", "google_search"]))
        );
    }

    static hasGeminiUrlContextTool(tools) {
        return (
            Array.isArray(tools) &&
            tools.some(tool => FormatConverter.hasGeminiToolKey(tool, ["urlContext", "url_context"]))
        );
    }

    static hasGeminiCodeExecutionTool(tools) {
        return (
            Array.isArray(tools) &&
            tools.some(tool => FormatConverter.hasGeminiToolKey(tool, ["codeExecution", "code_execution"]))
        );
    }

    hasGeminiFunctionDeclarations(geminiBody) {
        return !!(
            geminiBody &&
            Array.isArray(geminiBody.tools) &&
            geminiBody.tools.some(
                tool =>
                    tool &&
                    typeof tool === "object" &&
                    ((Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0) ||
                        (Array.isArray(tool.function_declarations) && tool.function_declarations.length > 0))
            )
        );
    }

    ensureServerSideToolInvocations(geminiBody) {
        const hasMixedTools = this.hasGeminiBuiltInTools(geminiBody) && this.hasGeminiFunctionDeclarations(geminiBody);
        if (!hasMixedTools && geminiBody?.toolConfig?.includeServerSideToolInvocations !== true) {
            return geminiBody;
        }

        if (
            !geminiBody.toolConfig ||
            typeof geminiBody.toolConfig !== "object" ||
            Array.isArray(geminiBody.toolConfig)
        ) {
            geminiBody.toolConfig = {};
        }

        if (geminiBody.toolConfig.includeServerSideToolInvocations !== true) {
            geminiBody.toolConfig.includeServerSideToolInvocations = true;
        }

        // Tool context circulation does not support AUTO. VALIDATED still allows
        // both natural language and tool calls; keep explicit NONE/ANY unchanged.
        const functionCallingConfig = geminiBody.toolConfig.functionCallingConfig;
        if (functionCallingConfig?.mode === "AUTO") {
            functionCallingConfig.mode = "VALIDATED";
        }

        return geminiBody;
    }

    /**
     * Copy a legacy Google Schema and normalize only schema-node Type enums.
     * Instance values (default/example/enum) and JSON Schema extensions remain untouched.
     */
    _normalizeGeminiSchemaTypes(schema) {
        if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
            return schema;
        }

        const normalized = { ...schema };
        if (typeof schema.type === "string") {
            normalized.type = schema.type.toUpperCase();
        }

        // Schema.properties is a map of names to schemas, not a schema itself.
        if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
            normalized.properties = Object.fromEntries(
                Object.entries(schema.properties).map(([name, child]) => [
                    name,
                    this._normalizeGeminiSchemaTypes(child),
                ])
            );
        }
        if (schema.items) {
            normalized.items = this._normalizeGeminiSchemaTypes(schema.items);
        }
        for (const key of ["anyOf", "any_of"]) {
            if (Array.isArray(schema[key])) {
                normalized[key] = schema[key].map(child => this._normalizeGeminiSchemaTypes(child));
            }
        }

        return normalized;
    }

    /**
     * Normalize legacy parameter and response schemas in native Gemini tool declarations.
     * @param {object} geminiBody - Gemini format request body
     * @returns {object} - Modified request body with normalized tool schema types
     */
    sanitizeGeminiTools(geminiBody) {
        if (!geminiBody || !geminiBody.tools || !Array.isArray(geminiBody.tools)) {
            return geminiBody;
        }

        // Process each tool
        for (const tool of geminiBody.tools) {
            const declarations =
                Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0
                    ? tool.functionDeclarations
                    : tool.function_declarations;
            if (declarations && Array.isArray(declarations)) {
                for (const funcDecl of declarations) {
                    if (!funcDecl || typeof funcDecl !== "object") continue;
                    for (const key of ["parameters", "response"]) {
                        if (funcDecl[key]) {
                            funcDecl[key] = this._normalizeGeminiSchemaTypes(funcDecl[key]);
                        }
                    }
                }
            }
        }

        return geminiBody;
    }

    /**
     * Normalize type values in a native Gemini responseSchema to Google's Type enum values.
     * @param {object} geminiBody - Gemini format request body
     * @returns {object} - Modified request body with normalized responseSchema types
     */
    normalizeGeminiResponseSchema(geminiBody) {
        const responseSchema = geminiBody?.generationConfig?.responseSchema;
        if (!responseSchema || typeof responseSchema !== "object") {
            return geminiBody;
        }

        geminiBody.generationConfig.responseSchema = this._normalizeGeminiSchemaTypes(responseSchema);
        return geminiBody;
    }

    /**
     * Common final processing for Gemini requests:
     * 1. Inject force features (Search, URL Context)
     * 2. Apply safety settings
     * 3. Log final request body
     * @param {object} googleRequest - The Gemini request object to finalize
     * @param {object} [options={}] - Per-request tool injection overrides.
     * @param {boolean} [options.forceCodeExecution] - When truthy, force-enable `codeExecution` for this request
     * even if `config.forceCodeExecution` is disabled.
     * @param {boolean} [options.forceWebSearch] - When truthy, force-enable `googleSearch` for this request even
     * if `config.forceWebSearch` is disabled. Falsy values fall back to the global setting. Current callers
     * use this for model-name-driven overrides such as the `-search` suffix.
     * @param {boolean} [options.forceUrlContext] - When truthy, force-enable `urlContext` for this request even if
     * `config.forceUrlContext` is disabled. Falsy values fall back to the global setting.
     * @protected
     */
    _finalizeGoogleRequest(googleRequest, options = {}) {
        const forceCodeExecution = options.forceCodeExecution || this.serverSystem.config.forceCodeExecution;
        const forceWebSearch = options.forceWebSearch || this.serverSystem.config.forceWebSearch;
        const forceUrlContext = options.forceUrlContext || this.serverSystem.config.forceUrlContext;

        // Force built-in tools
        if (forceWebSearch || forceUrlContext || forceCodeExecution) {
            if (!googleRequest.tools) {
                googleRequest.tools = [];
            }

            const toolsToAdd = [];

            // Handle Google Search
            if (forceWebSearch) {
                const hasSearch = FormatConverter.hasGeminiGoogleSearchTool(googleRequest.tools);
                if (!hasSearch) {
                    googleRequest.tools.push({ googleSearch: {} });
                    toolsToAdd.push("googleSearch");
                }
            }

            // Handle URL Context
            if (forceUrlContext) {
                const hasUrlContext = FormatConverter.hasGeminiUrlContextTool(googleRequest.tools);
                if (!hasUrlContext) {
                    googleRequest.tools.push({ urlContext: {} });
                    toolsToAdd.push("urlContext");
                }
            }

            // Handle Code Execution
            if (forceCodeExecution) {
                const hasCodeExecution = FormatConverter.hasGeminiCodeExecutionTool(googleRequest.tools);
                if (!hasCodeExecution) {
                    googleRequest.tools.push({ codeExecution: {} });
                    toolsToAdd.push("codeExecution");
                }
            }

            if (toolsToAdd.length > 0) {
                this.logger.info(`[Adapter] ⚠️ Force features enabled, injecting tools: [${toolsToAdd.join(", ")}]`);
            }
        }

        this.ensureServerSideToolInvocations(googleRequest);

        // Normalize contents for alternating turns, non-empty parts, and valid start/end roles
        this.normalizeGoogleContents(googleRequest);

        // Ensure all tools referenced in conversation history are declared
        this.ensureFunctionDeclarationsForContents(googleRequest);

        // Safety settings: do not inject default safetySettings unless explicitly requested and not OFF/BLOCK_NONE,
        // because Google Generative Language API on standard/free accounts rejects BLOCK_NONE/OFF with 400 INVALID_ARGUMENT.
        const configuredThreshold = this.serverSystem?.config?.safetySettingsThreshold;
        if (configuredThreshold && configuredThreshold !== "OFF" && configuredThreshold !== "BLOCK_NONE") {
            googleRequest.safetySettings = this.getDefaultSafetySettings();
        }

        this.logger.debug(`[Adapter] Debug: Final Gemini Request = ${JSON.stringify(googleRequest, null, 2)}`);
    }

    /**
     * Normalize Gemini request contents to ensure strict Google API compliance:
     * 1. Merges consecutive turns with the same role into a single turn (prevents "multiturn talk must alternate" 400 error).
     * 2. Filters out empty parts/turns.
     * 3. Ensures conversation starts with role: "user".
     * 4. Ensures conversation ends with role: "user" (e.g. if ending with model/prefill, adds continuation user turn).
     *
     * @param {object} googleRequest - Gemini request object
     */
    normalizeGoogleContents(googleRequest) {
        if (!googleRequest || !Array.isArray(googleRequest.contents) || googleRequest.contents.length === 0) {
            return;
        }

        const rawContents = googleRequest.contents;
        const normalized = [];

        for (const item of rawContents) {
            if (!item || typeof item !== "object") continue;
            const role = item.role || "user";
            const rawParts = Array.isArray(item.parts) ? item.parts : [];

            // Clean parts: filter null/undefined and empty text parts
            const cleanedParts = [];
            for (const part of rawParts) {
                if (!part || typeof part !== "object") continue;
                // Skip empty text parts if there are other fields or if text is empty
                if (typeof part.text === "string" && part.text.length === 0) {
                    continue;
                }
                cleanedParts.push(part);
            }

            if (cleanedParts.length === 0) {
                // If a turn had only empty text, keep a single whitespace part to avoid empty turn if necessary
                if (rawParts.some(p => typeof p?.text === "string")) {
                    cleanedParts.push({ text: " " });
                } else {
                    continue;
                }
            }

            if (normalized.length > 0 && normalized[normalized.length - 1].role === role) {
                // Merge consecutive same-role turns into the previous turn
                normalized[normalized.length - 1].parts.push(...cleanedParts);
            } else {
                normalized.push({
                    parts: cleanedParts,
                    role,
                });
            }
        }

        // If normalized is empty after filtering, ensure at least one valid user message
        if (normalized.length === 0) {
            normalized.push({
                parts: [{ text: "Hello" }],
                role: "user",
            });
        }

        // Gemini API constraint: First message must be "user"
        if (normalized[0].role !== "user") {
            normalized.unshift({
                parts: [{ text: "Hello" }],
                role: "user",
            });
        }

        // Gemini API constraint: Last message must be "user"
        // In Claude API, assistant prefill ends the messages array with role: "assistant".
        // Gemini expects the model to generate the next response, so input must end with "user".
        if (normalized[normalized.length - 1].role !== "user") {
            normalized.push({
                parts: [{ text: "Please continue and complete the response." }],
                role: "user",
            });
        }

        googleRequest.contents = normalized;
    }

    /**
     * Ensures all function calls and responses referenced in contents are declared in tools.
     * Prevents Gemini 400 INVALID_ARGUMENT ("functionCall/functionResponse is not declared in tools").
     *
     * @param {object} googleRequest - Gemini request object
     */
    ensureFunctionDeclarationsForContents(googleRequest) {
        if (!googleRequest || !Array.isArray(googleRequest.contents)) {
            return;
        }

        // Find all function names referenced in contents
        const referencedFunctionNames = new Set();
        for (const item of googleRequest.contents) {
            if (!item || !Array.isArray(item.parts)) continue;
            for (const part of item.parts) {
                if (part?.functionCall?.name) {
                    referencedFunctionNames.add(part.functionCall.name);
                }
                if (part?.functionResponse?.name) {
                    referencedFunctionNames.add(part.functionResponse.name);
                }
            }
        }

        if (referencedFunctionNames.size === 0) {
            return;
        }

        // Collect existing function declaration names
        const existingFunctionNames = new Set();
        if (Array.isArray(googleRequest.tools)) {
            for (const tool of googleRequest.tools) {
                const declarations = tool.functionDeclarations || tool.function_declarations;
                if (Array.isArray(declarations)) {
                    for (const decl of declarations) {
                        if (decl?.name) existingFunctionNames.add(decl.name);
                    }
                }
            }
        }

        // Find missing functions
        const missingNames = [];
        for (const name of referencedFunctionNames) {
            if (!existingFunctionNames.has(name)) {
                missingNames.push(name);
            }
        }

        if (missingNames.length > 0) {
            if (!Array.isArray(googleRequest.tools)) {
                googleRequest.tools = [];
            }
            let funcTool = googleRequest.tools.find(t => Array.isArray(t.functionDeclarations));
            if (!funcTool) {
                funcTool = { functionDeclarations: [] };
                googleRequest.tools.unshift(funcTool);
            }

            for (const name of missingNames) {
                funcTool.functionDeclarations.push({
                    description: "Auto-declared tool placeholder for historical conversation context",
                    name,
                    parametersJsonSchema: {
                        properties: {},
                        type: "object",
                    },
                });
                this.logger.info(`[Adapter] Injected missing tool declaration placeholder for: ${name}`);
            }
        }
    }

    /**
     * Map Gemini finishReason to OpenAI format
     * @param {string} geminiReason - Gemini finish reason
     * @returns {string} - OpenAI finish reason
     */
    _mapFinishReason(geminiReason) {
        const reasonMap = {
            max_tokens: "length",
            other: "stop",
            recitation: "stop",
            safety: "content_filter",
            stop: "stop",
        };
        return reasonMap[(geminiReason || "stop").toLowerCase()] || "stop";
    }

    _generateRequestId() {
        return `${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    }

    _normalizeWebSearchQueries(value) {
        const queries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
        return [
            ...new Set(queries.filter(query => typeof query === "string" && query.trim()).map(query => query.trim())),
        ];
    }

    _extractUrlContextMetadataEntries(metadata) {
        const entries =
            metadata?.urlMetadata || metadata?.url_metadata || metadata?.urlsMetadata || metadata?.urls_metadata || [];
        return Array.isArray(entries) ? entries : [];
    }

    _utf8ByteOffsetToStringIndex(value, byteOffset) {
        const targetOffset = Number.isFinite(byteOffset) ? Math.max(0, byteOffset) : 0;
        let currentByteOffset = 0;
        let stringIndex = 0;

        for (const character of value) {
            const characterBytes = Buffer.byteLength(character, "utf8");
            if (currentByteOffset + characterBytes > targetOffset) break;
            currentByteOffset += characterBytes;
            stringIndex += character.length;
            if (currentByteOffset === targetOffset) break;
        }

        return stringIndex;
    }

    _parseUsage(googleResponse) {
        const usage = googleResponse.usageMetadata || {};

        const inputTokens = usage.promptTokenCount || 0;
        const toolPromptTokens = usage.toolUsePromptTokenCount || 0;
        let cachedTokens = Number.isFinite(usage.cachedContentTokenCount)
            ? Math.max(0, usage.cachedContentTokenCount)
            : 0;

        if (!Number.isFinite(usage.cachedContentTokenCount) && Array.isArray(usage.cacheTokensDetails)) {
            cachedTokens = usage.cacheTokensDetails.reduce(
                (sum, detail) => sum + (Number.isFinite(detail?.tokenCount) ? Math.max(0, detail.tokenCount) : 0),
                0
            );
        }

        const completionTextTokens = usage.candidatesTokenCount || 0;
        const reasoningTokens = usage.thoughtsTokenCount || 0;
        let completionImageTokens = 0;

        if (Array.isArray(usage.candidatesTokensDetails)) {
            for (const d of usage.candidatesTokensDetails) {
                if (d?.modality === "IMAGE") {
                    completionImageTokens += d.tokenCount || 0;
                }
            }
        }

        const promptTokens = inputTokens + toolPromptTokens;
        cachedTokens = Math.min(cachedTokens, promptTokens);
        const totalCompletionTokens = completionTextTokens + reasoningTokens;
        const totalTokens = googleResponse.usageMetadata?.totalTokenCount || 0;

        return {
            completion_tokens: totalCompletionTokens,
            completion_tokens_details: {
                image_tokens: completionImageTokens,
                output_text_tokens: completionTextTokens,
                reasoning_tokens: reasoningTokens,
            },
            prompt_tokens: promptTokens,
            prompt_tokens_details: {
                cached_tokens: cachedTokens,
                text_tokens: inputTokens,
                tool_tokens: toolPromptTokens,
            },
            total_tokens: totalTokens,
        };
    }
}

module.exports = FormatConverter;
