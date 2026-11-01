/*
* SPDX-License-Identifier: LGPL-3.0-or-later
* Copyright © 2026 BotForge
*/

import {
    cloneRegex,
    createDiagnostic,
    DiagnosticCode,
    findMatchingBracket,
    FunctionScanRegex,
    getDocumentCodeBlocks,
    getExtensionConfig,
    getFunctions,
    isEscaped,
    isIgnored,
    LooseFunctionNameRegex,
    splitArgs
} from "."
import * as vscode from "vscode"

/**
 * Functions that declare or assign a variable.
 */
export const VariableDefinitionFunctions = ["$let"]

/**
 * Functions that read a variable.
 */
export const VariableUsageFunctions = ["$get", "$has", "$delete", "$letSum", "$letSub", "$letMulti", "$letDivide"]

/**
 * Functions that declare a local function.
 */
export const FunctionDefinitionFunctions = ["$localFunction"]

/**
 * Functions that call a custom or local function.
 */
export const FunctionCallFunctions = ["$callLocalFunction"]

type VariableDefinition = {
    name: string
    range: vscode.Range
}

type VariableUsage = {
    name: string
    range: vscode.Range
    runs: number
    resolved: number
}

type LocalFunction = {
    name: string
    start: number
    end: number
}

type ExecutionEvent =
    | { kind: "def", pos: number, name: string }
    | { kind: "use", pos: number, use: VariableUsage }
    | { kind: "call", pos: number, name: string }

/**
 * Limits how deep calls of local functions are followed.
 */
const MaxCallDepth = 16

/**
 * Resolves all names and aliases of the given functions.
 */
async function resolveNames(targets: string[]) {
    const names = new Set(targets.map((x) => x.toLowerCase()))
    const functions = await getFunctions()

    for (const fn of functions) {
        if (!names.has(fn.name.toLowerCase())) continue
        for (const alias of fn.aliases ?? []) names.add(alias.toLowerCase())
    }

    return names
}

/**
 * Validates variable declarations and usages of a text document.
 * @param document The text document to validate.
 * @param diagnostics The diagnostics array to push into.
 */
export async function validateVariables(document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const config = getExtensionConfig()
    if (!config.experimental.enabled) return
    if (!config.features.variables) return

    const text = document.getText()
    const blocks = getDocumentCodeBlocks(document)
    if (!blocks.length) return

    const defNames = await resolveNames(VariableDefinitionFunctions)
    const useNames = await resolveNames(VariableUsageFunctions)
    const fnNames = await resolveNames(FunctionDefinitionFunctions)
    const callNames = await resolveNames(FunctionCallFunctions)

    for (const block of blocks) {
        const defs: VariableDefinition[] = []
        const uses: VariableUsage[] = []
        const fns: LocalFunction[] = []
        const events: ExecutionEvent[] = []

        let dynamicDef = false
        let dynamicUse = false

        const Scan = cloneRegex(FunctionScanRegex)
        Scan.lastIndex = block.start
        let match: RegExpExecArray | null

        while ((match = Scan.exec(text))) {
            const index = match.index
            if (index >= block.end) break
            if (isEscaped(text, index) || isIgnored(text, index, block)) continue

            const full = match[0]
            if (!full.endsWith("[")) continue

            const typed = full.match(LooseFunctionNameRegex)?.[1]
            if (!typed) continue

            const name = "$" + typed.toLowerCase()
            const isDef = defNames.has(name)
            const isUse = useNames.has(name)
            const isFn = fnNames.has(name)
            const isCall = callNames.has(name)
            if (!isDef && !isUse && !isFn && !isCall) continue

            const openIndex = index + full.length - 1
            const closeIndex = findMatchingBracket(text, openIndex, block.end)
            if (closeIndex === -1 || closeIndex > block.end) continue

            const args = splitArgs(text.slice(openIndex + 1, closeIndex))
            const first = args[0]
            if (!first) continue

            const target = first.value.trim()
            if (!target) continue

            if (target.includes("$")) {
                if (isDef) dynamicDef = true
                else if (isUse) dynamicUse = true
                continue
            }

            if (isFn) {
                if (args.length > 1) {
                    fns.push({
                        name: target,
                        start: openIndex + 1 + first.end + 1,
                        end: closeIndex
                    })
                }
                continue
            }

            if (isCall) {
                events.push({ kind: "call", pos: closeIndex, name: target })
                continue
            }

            const lead = first.value.length - first.value.trimStart().length
            const startOffset = openIndex + 1 + first.start + lead
            const range = new vscode.Range(
                document.positionAt(startOffset),
                document.positionAt(startOffset + target.length)
            )

            if (isDef) {
                defs.push({ name: target, range })
                events.push({ kind: "def", pos: closeIndex, name: target })
            } else {
                const use: VariableUsage = {
                    name: target,
                    range,
                    runs: 0,
                    resolved: 0
                }

                uses.push(use)
                events.push({ kind: "use", pos: index, use })
            }
        }

        const ownerOf = (pos: number) => {
            let owner: LocalFunction | null = null

            for (const fn of fns) {
                if (pos < fn.start || pos >= fn.end) continue
                if (!owner || fn.start > owner.start) owner = fn
            }

            return owner
        }

        const byOwner = new Map<LocalFunction | null, ExecutionEvent[]>()
        for (const event of events) {
            const owner = ownerOf(event.pos)
            const list = byOwner.get(owner)

            if (list) list.push(event)
            else byOwner.set(owner, [event])
        }
        for (const list of byOwner.values()) list.sort((a, b) => a.pos - b.pos)

        const fnsByName = new Map<string, LocalFunction[]>()
        for (const fn of fns) {
            const list = fnsByName.get(fn.name)

            if (list) list.push(fn)
            else fnsByName.set(fn.name, [fn])
        }

        // Simulate execution
        const defined = new Set<string>()
        const run = (owner: LocalFunction | null, stack: LocalFunction[]) => {
            for (const event of byOwner.get(owner) ?? []) {
                if (event.kind === "def") {
                    defined.add(event.name)
                } else if (event.kind === "use") {
                    event.use.runs++
                    if (defined.has(event.use.name)) event.use.resolved++
                } else {
                    if (stack.length >= MaxCallDepth) continue

                    for (const fn of fnsByName.get(event.name) ?? []) {
                        if (stack.includes(fn)) continue
                        run(fn, [...stack, fn])
                    }
                }
            }
        }
        run(null, [])

        // Undefined / Used before definition
        if (!dynamicDef) {
            const declared = new Set(defs.map((x) => x.name))

            for (const use of uses) {
                if (use.runs === 0 || use.resolved > 0) continue

                diagnostics.push(createDiagnostic(
                    use.range,
                    declared.has(use.name)
                        ? vscode.l10n.t(`Variable "{0}" is used before it is defined`, use.name)
                        : vscode.l10n.t(`Variable "{0}" is not defined`, use.name),
                    vscode.DiagnosticSeverity.Warning,
                    DiagnosticCode.UndefinedVariable
                ))
            }
        }

        // Unused
        if (!dynamicUse) {
            const read = new Set(uses.map((x) => x.name))

            for (const def of defs) {
                if (read.has(def.name)) continue

                const diagnostic = createDiagnostic(
                    def.range,
                    vscode.l10n.t(`Variable "{0}" is declared but never used`, def.name),
                    vscode.DiagnosticSeverity.Hint,
                    DiagnosticCode.UnusedVariable
                )
                diagnostic.tags = [vscode.DiagnosticTag.Unnecessary]
                diagnostics.push(diagnostic)
            }
        }
    }
}