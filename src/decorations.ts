/*
* SPDX-License-Identifier: LGPL-3.0-or-later
* Copyright © 2026 BotForge
*/

import {
    cloneRegex,
    ConditionOperators,
    findConditionOperator,
    findFunction,
    findMatchingBracket,
    FunctionPrefixRegex,
    FunctionScanRegex,
    type FunctionStyle,
    getExtensionConfig,
    isEscaped,
    isIgnored,
    isOpeningBracket,
    Languages,
    locateCodeBlock,
    ParsedArg,
    splitArgs
} from "."
import * as vscode from "vscode"

let decoFn: vscode.TextEditorDecorationType | null = null
let decoDollar: vscode.TextEditorDecorationType | null = null
let decoSemi: vscode.TextEditorDecorationType | null = null
let decoCond: vscode.TextEditorDecorationType | null = null
let decoNum: vscode.TextEditorDecorationType | null = null
let decoBool: vscode.TextEditorDecorationType | null = null
let decoOpNeg: vscode.TextEditorDecorationType | null = null
let decoOpSilent: vscode.TextEditorDecorationType | null = null
let decoOpCount: vscode.TextEditorDecorationType | null = null
let decoOpCountDelim: vscode.TextEditorDecorationType | null = null

export const HexRegex = /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
export const NumberRegex = /^-?\d+(?:\.\d+)?$/
export const BooleanRegex = /^(?:true|false)$/

const NumberThemeColor = "debugTokenExpression.number"
const BooleanThemeColor = "debugTokenExpression.boolean"

/**
 * Checks whether the input is a valid hex color.
 * @param input The input text.
 */
function isValidHex(input: string) {
    return HexRegex.test(input.trim())
}

/**
 * Resolves a color input.
 * @param input The input text.
 * @param color The color fallback value.
 */
export function resolveColor(input: unknown, color: string) {
    const hex = typeof input === "string" ? input.trim() : ""
    if (!isValidHex(hex)) return color
    return hex.startsWith("#") ? hex : ("#" + hex)
}

/**
 * Resolves a color input for themes.
 * @param input The input text.
 * @param themeColor The theme color id fallback value.
 */
function resolveThemeColor(input: unknown, themeColor: string) {
    const hex = typeof input === "string" ? input.trim() : ""
    if (!isValidHex(hex)) return new vscode.ThemeColor(themeColor)
    return hex.startsWith("#") ? hex : ("#" + hex)
}

/**
 * Returns the raw key of a color.
 * @param color The color input.
 */
function colorKey(color: string | vscode.ThemeColor) {
    return typeof color === "string" ? color : "theme:" + color.id
}

/**
 * Resolves a font style.
 * @param style The style to resolve.
 */
function resolveFontStyle(style?: FunctionStyle) {
    switch (style) {
        case "bold":
            return { fontWeight: "bold" }

        case "italic":
            return { fontStyle: "italic" }

        case "bold-italic":
            return { fontWeight: "bold", fontStyle: "italic" }

        default:
            return { fontWeight: "normal", fontStyle: "normal" }
    }
}

let lastDecoKey = ""

/**
 * (Re)creates decoration types only when config colors changed.
 */
function ensureDecorations() {
    const config = getExtensionConfig()
    const colors = config.colors ?? {}
    const formatting = config.formatting ?? {}

    const fnStyle = resolveFontStyle(formatting.function?.style)

    const fnColor = resolveColor(colors.function?.name, "#AC75FF")
    const dollarColor = resolveColor(colors.function?.dollar, "#FE7CEB")
    const semiColor = resolveColor(colors.function?.semicolon, "#C586C0")

    const condColor = resolveColor(colors.arguments?.condition, "#4FC1FF")
    const numColor = resolveThemeColor(colors.arguments?.number, NumberThemeColor)
    const boolColor = resolveThemeColor(colors.arguments?.boolean, BooleanThemeColor)

    const negColor = resolveColor(colors.operators?.negation, dollarColor)
    const silentColor = resolveColor(colors.operators?.silent, dollarColor)
    const countColor = resolveColor(colors.operators?.count, dollarColor)
    const countDelimColor = resolveColor(colors.operators?.countDelimiter, countColor)

    const key = [
        fnColor,
        dollarColor,
        semiColor,
        condColor,
        negColor,
        silentColor,
        countColor,
        countDelimColor,
        colorKey(numColor),
        colorKey(boolColor),
        JSON.stringify(fnStyle)
    ].join("|")

    if (key === lastDecoKey && decoFn) return
    lastDecoKey = key

    const decoTypes = [
        decoFn,
        decoDollar,
        decoSemi,
        decoCond,
        decoNum,
        decoBool,
        decoOpNeg,
        decoOpSilent,
        decoOpCount,
        decoOpCountDelim
    ]

    for (const d of decoTypes) d?.dispose()

    decoFn = vscode.window.createTextEditorDecorationType({ color: fnColor, ...fnStyle })
    decoDollar = vscode.window.createTextEditorDecorationType({ color: dollarColor, ...fnStyle })
    decoSemi = vscode.window.createTextEditorDecorationType({ color: semiColor })

    decoCond = vscode.window.createTextEditorDecorationType({ color: condColor })
    decoNum = vscode.window.createTextEditorDecorationType({ color: numColor })
    decoBool = vscode.window.createTextEditorDecorationType({ color: boolColor })

    decoOpNeg = vscode.window.createTextEditorDecorationType({ color: negColor })
    decoOpSilent = vscode.window.createTextEditorDecorationType({ color: silentColor })
    decoOpCount = vscode.window.createTextEditorDecorationType({ color: countColor })
    decoOpCountDelim = vscode.window.createTextEditorDecorationType({ color: countDelimColor })
}

/**
 * Splits a condition argument into its operands.
 * @param input The argument value.
 */
export function splitConditionOperands(input: string) {
    const operands: ParsedArg[] = []
    let depth = 0
    let start = 0

    const push = (end: number) => operands.push({
        value: input.slice(start, end),
        start,
        end
    })

    for (let i = 0; i < input.length; i++) {
        const ch = input[i]

        if (ch === "[" && isOpeningBracket(input, i)) {
            depth++
            continue
        }

        if (ch === "]" && depth > 0 && !isEscaped(input, i)) {
            depth--
            continue
        }

        if (depth > 0) continue

        const separator = ConditionOperators.find((op) => input.startsWith(op, i))
        if (separator) {
            push(i)
            start = i + separator.length
            i += separator.length - 1
        }
    }

    push(input.length)
    return operands
}

/**
 * Collects the range of a value if it is a plain number or boolean literal.
 * @param doc The text document.
 * @param value The raw value.
 * @param offset The document offset of the raw value.
 * @param allowNumber Whether number literals should be collected.
 * @param allowBoolean Whether boolean literals should be collected.
 * @param numbers The number ranges to push into.
 * @param booleans The boolean ranges to push into.
 */
function collectLiteral(
    doc: vscode.TextDocument,
    value: string,
    offset: number,
    allowNumber: boolean,
    allowBoolean: boolean,
    numbers: vscode.Range[],
    booleans: vscode.Range[]
) {
    const trimmed = value.trim()
    if (!trimmed) return

    const start = offset + (value.length - value.trimStart().length)
    const range = new vscode.Range(doc.positionAt(start), doc.positionAt(start + trimmed.length))

    if (allowNumber && NumberRegex.test(trimmed)) numbers.push(range)
    else if (allowBoolean && BooleanRegex.test(trimmed)) booleans.push(range)
}

async function applyDecorations(editor: vscode.TextEditor) {
    ensureDecorations()

    if (
        !decoFn ||
        !decoDollar ||
        !decoSemi ||
        !decoCond ||
        !decoNum ||
        !decoBool ||
        !decoOpNeg ||
        !decoOpSilent ||
        !decoOpCount ||
        !decoOpCountDelim
    ) {
        return
    }

    const doc = editor.document
    const text = doc.getText()

    const fnRanges: vscode.Range[] = []
    const dollarRanges: vscode.Range[] = []
    const semiRanges: vscode.Range[] = []
    const condRanges: vscode.Range[] = []
    const numRanges: vscode.Range[] = []
    const boolRanges: vscode.Range[] = []
    const opNegRanges: vscode.Range[] = []
    const opSilentRanges: vscode.Range[] = []
    const opCountRanges: vscode.Range[] = []
    const opCountDelimRanges: vscode.Range[] = []

    const ScanRegex = cloneRegex(FunctionScanRegex)
    ScanRegex.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = ScanRegex.exec(text))) {
        const matchIndex = match.index
        const startPos = doc.positionAt(matchIndex)
        const block = locateCodeBlock(doc, startPos)
        if (!block || isEscaped(text, matchIndex) || isIgnored(text, matchIndex, block)) continue

        const full = match[0]
        const hasOpening = full.endsWith("[")

        let found = await findFunction(full)
        if (!found && hasOpening) found = await findFunction(full.slice(0, -1))
        if (!found) continue

        const { matchedText, fn } = found
        if (fn.name === "$c" && hasOpening) continue

        const prefixMatch = matchedText.match(FunctionPrefixRegex)?.[0] ?? "$"
        const nameLength = Math.max(matchedText.length - prefixMatch.length, 0)
        if (nameLength <= 0) continue

        const nameStart = matchIndex + prefixMatch.length
        fnRanges.push(new vscode.Range(doc.positionAt(nameStart), doc.positionAt(nameStart + nameLength)))
        dollarRanges.push(new vscode.Range(doc.positionAt(matchIndex), doc.positionAt(matchIndex + 1)))

        const prefix = prefixMatch
        for (let i = 0; i < prefix.length; i++) {
            const c = prefix[i]
            const abs = matchIndex + i

            if (c === "!") {
                opNegRanges.push(new vscode.Range(doc.positionAt(abs), doc.positionAt(abs + 1)))
            } else if (c === "#") {
                opSilentRanges.push(new vscode.Range(doc.positionAt(abs), doc.positionAt(abs + 1)))
            } else if (c === "@") {
                const j = prefix.indexOf("@[", i)
                const k = j !== -1 ? prefix.indexOf("]", j) : -1
                if (j !== -1 && k !== -1) {
                    const absStart = matchIndex + j
                    const absEnd = matchIndex + k + 1
                    const hasDelim = k === j + 3

                    if (hasDelim) {
                        const delimAbs = absStart + 2
                        opCountRanges.push(new vscode.Range(doc.positionAt(absStart), doc.positionAt(absStart + 2)))
                        opCountRanges.push(new vscode.Range(doc.positionAt(absEnd - 1), doc.positionAt(absEnd)))
                        opCountDelimRanges.push(new vscode.Range(doc.positionAt(delimAbs), doc.positionAt(delimAbs + 1)))
                    } else {
                        opCountRanges.push(new vscode.Range(doc.positionAt(absStart), doc.positionAt(absEnd)))
                    }
                }
                break
            }
        }

        const acceptsArgs = fn.brackets !== undefined
        if (!acceptsArgs || !full.endsWith("[")) continue

        const openIndex = matchIndex + full.length - 1
        const closeIndex = findMatchingBracket(text, openIndex, block.end)
        if (closeIndex === -1) continue

        const argText = text.slice(openIndex + 1, closeIndex)
        const args = splitArgs(argText)

        for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            const meta = fn.args?.[Math.min(i, fn.args.at(-1)?.rest ? fn.args.length - 1 : i)]
            if (!meta) continue

            const argOffset = openIndex + 1 + arg.start

            if (meta.condition) {
                for (const operand of splitConditionOperands(arg.value)) {
                    collectLiteral(doc, operand.value, argOffset + operand.start, true, true, numRanges, boolRanges)
                }

                const op = findConditionOperator(arg.value)
                if (op) {
                    const start = argOffset + op.start
                    const end = start + op.operator.length
                    condRanges.push(new vscode.Range(doc.positionAt(start), doc.positionAt(end)))
                }
            } else {
                collectLiteral(
                    doc,
                    arg.value,
                    argOffset,
                    meta.type === "Number",
                    meta.type === "Boolean",
                    numRanges,
                    boolRanges
                )
            }
        }

        let depth = 0
        for (let i = openIndex + 1; i < closeIndex; i++) {
            const escaped = isEscaped(text, i)
            const ch = text[i]

            if (ch === "[" && isOpeningBracket(text, i)) depth++
            else if (ch === "]" && depth > 0 && !escaped) depth--
            else if (ch === ";" && depth === 0 && !escaped) {
                semiRanges.push(new vscode.Range(doc.positionAt(i), doc.positionAt(i + 1)))
            }
        }
    }

    editor.setDecorations(decoFn, fnRanges)
    editor.setDecorations(decoDollar, dollarRanges)
    editor.setDecorations(decoSemi, semiRanges)
    editor.setDecorations(decoCond, condRanges)
    editor.setDecorations(decoNum, numRanges)
    editor.setDecorations(decoBool, boolRanges)
    editor.setDecorations(decoOpNeg, opNegRanges)
    editor.setDecorations(decoOpSilent, opSilentRanges)
    editor.setDecorations(decoOpCount, opCountRanges)
    editor.setDecorations(decoOpCountDelim, opCountDelimRanges)
}

/**
 * Registers the decorations for syntax highlighting.
 * @param ctx The extension context.
 */
export function registerDecorations(ctx: vscode.ExtensionContext) {
    ensureDecorations()

    const updateAll = () => {
        for (const editor of vscode.window.visibleTextEditors) {
            if (!Languages.includes(editor.document.languageId)) continue
            applyDecorations(editor)
        }
    }

    const decoTypes = [
        decoFn,
        decoDollar,
        decoSemi,
        decoCond,
        decoNum,
        decoBool,
        decoOpNeg,
        decoOpSilent,
        decoOpCount,
        decoOpCountDelim
    ]

    ctx.subscriptions.push(
        {
            dispose: () => {
                for (const d of decoTypes) d?.dispose()
            }
        },
        vscode.window.onDidChangeVisibleTextEditors(() => updateAll()),
        vscode.workspace.onDidChangeTextDocument((e) => {
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document !== e.document) continue
                applyDecorations(editor)
            }
        })
    )

    updateAll()
}