/*
* SPDX-License-Identifier: LGPL-3.0-or-later
* Copyright © 2026 BotForge
*/

import {
	cloneRegex,
	findFunction,
	findMatchingBracket,
	FunctionPrefixRegex,
	FunctionScanRegex,
	getExtensionConfig,
	isEscaped,
	isIgnored,
	Languages,
	locateCodeBlock,
	splitArgs,
	validateEventTypes,
	validateOperatorPrefix,
	validateVariables
} from "."
import * as vscode from "vscode"

export const DiagnosticSource = "forgevsc"

/**
 * - 1xxx - Functions
 * - 2xxx - Syntax and Operators
 * - 3xxx - Arguments
 * - 4xxx - Events
 * - 5xxx - Variables
 */
export enum DiagnosticCode {
	DeprecatedFunction = 1001,
	ExperimentalFunction = 1002,

	InvalidOperatorOrder = 2001,
	DuplicateOperator = 2002,
	MissingBrackets = 2003,
	UnclosedBracket = 2004,

	MissingArgument = 3001,
	TooManyArguments = 3002,

	DeprecatedEvent = 4001,
	UnknownEvent = 4002,

	UnusedVariable = 5001,
	UndefinedVariable = 5002
}

export function createDiagnostic(
	range: vscode.Range,
	message: string,
	severity: vscode.DiagnosticSeverity,
	code: DiagnosticCode
) {
	const diagnostic = new vscode.Diagnostic(range, message, severity)
	diagnostic.source = DiagnosticSource
	diagnostic.code = code
	return diagnostic
}

export function getDiagnosticCode(diagnostic: vscode.Diagnostic) {
	const code = diagnostic.code
	const value = typeof code === "object" ? code.value : code

	return typeof value === "number" && DiagnosticCode[value] !== undefined ? value : undefined
}

/**
 * Validates a document for diagnostics.
 * @param document The document to validate.
 * @param collection The diagnostic collection.
 */
export async function validateDocument(
	document: vscode.TextDocument | undefined,
	collection: vscode.DiagnosticCollection
) {
	const config = getExtensionConfig()
	if (!document || !Languages.includes(document.languageId) || !config.features.diagnostics) return

	const diagnostics: vscode.Diagnostic[] = []
	const text = document.getText()
	// const Regex = /^\$!?#?(?:@\[[^\]]*\])?/

	const ScanRegex = cloneRegex(FunctionScanRegex)
	ScanRegex.lastIndex = 0
	let match: RegExpExecArray | null

	while ((match = ScanRegex.exec(text))) {
		const index = match.index
		const start = document.positionAt(index)
		const block = locateCodeBlock(document, start)
		if (!block || isEscaped(text, index) || isIgnored(text, index, block)) continue

		const full = match[0]
		const hasOpening = full.endsWith("[")
		const base = hasOpening ? full.slice(0, -1) : full

		const found = await findFunction(base, true)
		if (!found) continue

		const { fn, matchedText } = found
		const end = document.positionAt(index + matchedText.length)

		// Deprecation warning
		if (fn.deprecated) {
			const hint = createDiagnostic(
				new vscode.Range(start, end),
				vscode.l10n.t("This function is deprecated and its use is discouraged. It may be removed in upcoming releases. Use a supported alternative if available."),
				vscode.DiagnosticSeverity.Hint,
				DiagnosticCode.DeprecatedFunction
			)
			const warning = createDiagnostic(
				new vscode.Range(start, end),
				vscode.l10n.t("Function `{0}` is deprecated. Use an available alternative instead", fn.name),
				vscode.DiagnosticSeverity.Warning,
				DiagnosticCode.DeprecatedFunction
			)
			warning.tags = [vscode.DiagnosticTag.Deprecated]
			diagnostics.push(hint, warning)
		}

		// Experimental hint
		if (fn.experimental) {
			const diagnostic = createDiagnostic(
				new vscode.Range(start, end),
				vscode.l10n.t("This is an experimental function. It may not work as expected and is not guaranteed to be stable. Expect bugs, changes, or removal."),
				vscode.DiagnosticSeverity.Hint,
				DiagnosticCode.ExperimentalFunction
			)
			diagnostics.push(diagnostic)
		}
		const { isInvalidOrder, rawPrefix } = validateOperatorPrefix(base)

		// Invalid operator order
		if (isInvalidOrder) {
			const offset = rawPrefix.length
			const opStart = document.positionAt(index + 1)
			const opEnd = document.positionAt(index + offset)
			diagnostics.push(createDiagnostic(
				new vscode.Range(opStart, opEnd),
				vscode.l10n.t("Function `{0}` has invalid operator order", fn.name),
				vscode.DiagnosticSeverity.Error,
				DiagnosticCode.InvalidOperatorOrder
			))
			continue
		}

		// Duplicated operators
		const strictPrefix = base.match(FunctionPrefixRegex)?.[0] ?? "$"
		if (rawPrefix.length > strictPrefix.length) {
			diagnostics.push(createDiagnostic(
				new vscode.Range(document.positionAt(index + 1), document.positionAt(index + rawPrefix.length)),
				vscode.l10n.t("Function `{0}` has duplicated operators supplied", fn.name),
				vscode.DiagnosticSeverity.Error,
				DiagnosticCode.DuplicateOperator
			))
			continue
		}

		const isAttached = matchedText.length === base.length && matchedText.toLowerCase() === base.toLowerCase()
		const hasOpeningAttached = hasOpening && isAttached

		const args = fn.args ?? []
		const acceptsArgs = fn.brackets !== undefined && args.length > 0
		const requiresArgs = fn.brackets

		const range = new vscode.Range(start, end)

		// Missing required brackets
		if (requiresArgs && !hasOpeningAttached) {
			diagnostics.push(createDiagnostic(
				range,
				vscode.l10n.t("Function `{0}` requires brackets", fn.name),
				vscode.DiagnosticSeverity.Error,
				DiagnosticCode.MissingBrackets
			))
			continue
		}

		if (!isAttached || args.length === 0) continue

		if (acceptsArgs && hasOpening) {
			const openIndex = index + full.length - 1
			const closeIndex = findMatchingBracket(text, openIndex, block.end)

			// Missing closing bracket
			if (closeIndex === -1) {
				diagnostics.push(createDiagnostic(
					range,
					vscode.l10n.t("Function `{0}` is missing brace closure", fn.name),
					vscode.DiagnosticSeverity.Error,
					DiagnosticCode.UnclosedBracket
				))
				continue
			}

			const argString = text.slice(openIndex + 1, closeIndex)
			const providedArgs = splitArgs(argString)

			// Too few arguments
			for (let i = 0; i < args.length; i++) {
				const expected = args[i]
				const provided = providedArgs[i]

				if (expected.required && provided === undefined) {
					const argStart = document.positionAt(openIndex + 1)
					const argEnd = document.positionAt(closeIndex)
					diagnostics.push(createDiagnostic(
						new vscode.Range(argStart, argEnd),
						vscode.l10n.t("Function `{0}` is missing argument `{1}`", fn.name, expected.name),
						vscode.DiagnosticSeverity.Error,
						DiagnosticCode.MissingArgument
					))
				}
			}

			// Too many arguments
			if (providedArgs.length > args.length && !args.at(-1)?.rest) {
				const end = document.positionAt(closeIndex + 1)
				diagnostics.push(createDiagnostic(
					new vscode.Range(start, end),
					args.length === 1
						? vscode.l10n.t("Function `{0}` expects 1 argument at most, received {1}", fn.name, providedArgs.length)
						: vscode.l10n.t("Function `{0}` expects {1} arguments at most, received {2}", fn.name, args.length, providedArgs.length),
					vscode.DiagnosticSeverity.Error,
					DiagnosticCode.TooManyArguments
				))
			}
		}
	}

	await validateEventTypes(document, diagnostics)
	await validateVariables(document, diagnostics)

	collection.set(document.uri, diagnostics)
}