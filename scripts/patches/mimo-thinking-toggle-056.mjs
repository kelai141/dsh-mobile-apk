/** MiMo binary-thinking adapter for the pinned DSH/PiAi runtime contract. */
export const MIMO_PATCH_MARKER = 'dsh-mobile MiMo thinking toggle (issue #56)'
export const MIMO_PI_FILE = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'

const DSH_PROFILE_FILE = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'

function replaceOnce(text, before, after, marker) {
  const count = text.split(before).length - 1
  if (count !== 1) throw new Error(`MiMo patch anchor ${marker}: expected exactly one match, got ${count}`)
  return text.replace(before, after)
}

export function patchDshThinkingProfile(source) {
  if (source.includes(MIMO_PATCH_MARKER)
      && source.includes('const efforts = ["off", "low"]')
      && source.includes('isMimoToggleModel(model)')
      && source.includes('...profileOptions(profile, reasoning, apiKey, model),')) return source
  const before = `\t"ant-ling": true\n});`
  const after = `\t"ant-ling": true,\n\t"mimo": true\n}); // ${MIMO_PATCH_MARKER}`
  let result = replaceOnce(source, before, after, 'thinkingFormat allowlist')

  const profileOptionsBefore = `function profileOptions(profile, reasoning, apiKey) {\n\tconst enabledReasoning = reasoning === "off" ? void 0 : reasoning;`
  const profileOptionsAfter = `function profileOptions(profile, reasoning, apiKey, model) {\n\tconst isMimoToggle = model?.api === "openai-completions" && model?.compat?.thinkingFormat === "mimo";\n\tconst enabledReasoning = reasoning === "off" && !isMimoToggle ? void 0 : reasoning; // ${MIMO_PATCH_MARKER}`
  result = replaceOnce(result, profileOptionsBefore, profileOptionsAfter, 'preserve explicit off')
  result = replaceOnce(result, '...profileOptions(profile, reasoning, apiKey),', '...profileOptions(profile, reasoning, apiKey, model),', 'profile option model context')

  const describeBefore = `function describableReasoningLevel(model, effort) {\n\tif (effort === void 0) return void 0;\n\treturn getSupportedThinkingLevels(model).some((level) => level === effort) ? effort : void 0;\n}`
  const describeAfter = `function isMimoToggleModel(model) {\n\treturn model?.api === "openai-completions" && model?.compat?.thinkingFormat === "mimo";\n}\nfunction describableReasoningLevel(model, effort) {\n\tif (effort === void 0) return void 0;\n\tif (isMimoToggleModel(model)) return effort === "off" ? "off" : "low";\n\treturn getSupportedThinkingLevels(model).some((level) => level === effort) ? effort : void 0;\n}`
  result = replaceOnce(result, describeBefore, describeAfter, 'canonical default for legacy effort')
  const resolveBefore = `function resolveReasoningLevel(model, effort) {\n\tif (effort === void 0) return void 0;\n\tif (getSupportedThinkingLevels(model).some((level) => level === effort)) return effort;\n\tthrow new LlmError(\`pi-ai provider "${'${model.provider}'}" model "${'${model.id}'}" does not support reasoning effort "${'${effort}'}"\`, "UNSUPPORTED_REASONING_EFFORT");\n}`
  const resolveAfter = `function resolveReasoningLevel(model, effort) {\n\tif (effort === void 0) return void 0;\n\tif (isMimoToggleModel(model)) return effort === "off" ? "off" : "low";\n\tif (getSupportedThinkingLevels(model).some((level) => level === effort)) return effort;\n\tthrow new LlmError(\`pi-ai provider "${'${model.provider}'}" model "${'${model.id}'}" does not support reasoning effort "${'${effort}'}"\`, "UNSUPPORTED_REASONING_EFFORT");\n}`
  result = replaceOnce(result, resolveBefore, resolveAfter, 'canonical request effort for legacy setting')

  const reasoningInfoBefore = `function reasoningInfo(model, defaultLevel) {\n\tif (!model.reasoning) return {};\n\treturn { reasoning: {\n\t\tefforts: getSupportedThinkingLevels(model).map((level) => ({\n\t\t\tid: ReasoningEffortId(level),\n\t\t\tname: \`${'${level.charAt(0).toUpperCase()}${level.slice(1)}'}\`\n\t\t})),\n\t\t...defaultLevel === void 0 ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) }\n\t} };\n}`
  const reasoningInfoAfter = `function reasoningInfo(model, defaultLevel) {\n\tif (!model.reasoning) return {};\n\tif (model.api === "openai-completions" && model.compat?.thinkingFormat === "mimo") {\n\t\tconst efforts = ["off", "low"];\n\t\treturn { reasoning: { efforts: efforts.map((level) => ({ id: ReasoningEffortId(level), name: level === "off" ? "关闭思考" : "开启思考" })), defaultEffort: ReasoningEffortId(defaultLevel === "off" ? "off" : "low") } };\n\t}\n\treturn { reasoning: {\n\t\tefforts: getSupportedThinkingLevels(model).map((level) => ({\n\t\t\tid: ReasoningEffortId(level),\n\t\t\tname: \`${'${level.charAt(0).toUpperCase()}${level.slice(1)}'}\`\n\t\t})),\n\t\t...defaultLevel === void 0 ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) }\n\t} };\n}`
  result = replaceOnce(result, reasoningInfoBefore, reasoningInfoAfter, 'binary selector labels')
  return result
}

export function patchPiAiMimoThinking(source) {
  if (source.includes(MIMO_PATCH_MARKER) && source.includes('const isMimoToggle = getCompat(model).thinkingFormat === "mimo";')) return source
  let result = replaceOnce(
    source,
    'const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;\n    const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;',
    'const isMimoToggle = getCompat(model).thinkingFormat === "mimo";\n    const clampedReasoning = options?.reasoning ? isMimoToggle ? options.reasoning === "off" ? "off" : "low" : clampThinkingLevel(model, options.reasoning) : undefined;\n    const reasoningEffort = clampedReasoning === "off" && !isMimoToggle ? undefined : clampedReasoning; // ' + MIMO_PATCH_MARKER,
    'preserve off for toggle serializer',
  )
  result = replaceOnce(
    result,
    '    if (compat.thinkingFormat === "zai" && model.reasoning) {',
    '    if (compat.thinkingFormat === "mimo" && model.reasoning) {\n        params.thinking = { type: options?.reasoningEffort === "off" ? "disabled" : "enabled" };\n    }\n    else if (compat.thinkingFormat === "zai" && model.reasoning) {',
    'binary request body',
  )
  return result
}

export function planMimoThinking(read) {
  const dshFile = DSH_PROFILE_FILE
  const piFile = MIMO_PI_FILE
  const dshBefore = read(dshFile)
  const piBefore = read(piFile)
  const dshManifest = JSON.parse(read('usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json'))
  const piManifest = JSON.parse(read('usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/package.json'))
  if (dshManifest.version !== '0.2.1-rc.2' || piManifest.version !== '1.1.0') {
    throw new Error('mimo-thinking-toggle-056 requires dsh-llm-pi-ai@0.2.1-rc.2 and pi-ai@1.1.0')
  }
  return [
    { file: dshFile, before: dshBefore, after: patchDshThinkingProfile(dshBefore) },
    { file: piFile, before: piBefore, after: patchPiAiMimoThinking(piBefore) },
  ]
}
