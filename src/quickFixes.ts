/*
* SPDX-License-Identifier: LGPL-3.0-or-later
* Copyright © 2026 BotForge
*/

import { activate, DiagnosticCode, DiagnosticSource, getDiagnosticCode, getEvents, getEventSuggestions, getExtensionConfig, Languages } from "."
import * as vscode from "vscode"

const OperatorTokenRegex = /@\[[^\]]*\]|[!#]/g

/**
 * Reorders an operator chain to the canonical order.
 * @param text The operator chain without the leading prefix.
 */
function reorderOperators(text: string) {
	const tokens = text.match(OperatorTokenRegex)
	if (!tokens || tokens.join("").length !== text.length) return null

	const negation = tokens.find((t) => t === "!")
	const silent = tokens.find((t) => t === "#")
	const count = tokens.find((t) => t.startsWith("@"))

	return [negation, silent, count].filter(Boolean).join("")
}

function fixInvalidOperatorOrder(document: vscode.TextDocument, diagnostic: vscode.Diagnostic) {
	const current = document.getText(diagnostic.range)
	const fixed = reorderOperators(current)
	if (!fixed || fixed === current) return

	const action = new vscode.CodeAction(
		vscode.l10n.t("Reorder operators to `{0}`", fixed),
		vscode.CodeActionKind.QuickFix
	)
	action.edit = new vscode.WorkspaceEdit()
	action.edit.replace(document.uri, diagnostic.range, fixed)
	action.diagnostics = [diagnostic]
	action.isPreferred = true

	return action
}

function fixDuplicateOperators(document: vscode.TextDocument, diagnostic: vscode.Diagnostic) {
	const current = document.getText(diagnostic.range)
	const fixed = reorderOperators(current)
	if (fixed === null || fixed === current) return

	const action = new vscode.CodeAction(
		vscode.l10n.t("Remove duplicated operators"),
		vscode.CodeActionKind.QuickFix
	)
	action.edit = new vscode.WorkspaceEdit()
	action.edit.replace(document.uri, diagnostic.range, fixed)
	action.diagnostics = [diagnostic]
	action.isPreferred = true

	return action
}

function fixMissingBrackets(document: vscode.TextDocument, diagnostic: vscode.Diagnostic) {
	const end = diagnostic.range.end
	const next = document.getText(new vscode.Range(end, end.translate(0, 1)))
	if (/[a-zA-Z0-9\[]/.test(next)) return

	const action = new vscode.CodeAction(
		vscode.l10n.t("Insert brackets `[]`"),
		vscode.CodeActionKind.QuickFix
	)
	action.edit = new vscode.WorkspaceEdit()
	action.edit.insert(document.uri, end, "[]")
	action.diagnostics = [diagnostic]
	action.isPreferred = true

	return action
}

async function fixUnknownEvent(document: vscode.TextDocument, diagnostic: vscode.Diagnostic) {
	const name = document.getText(diagnostic.range)
	const suggestions = getEventSuggestions(name, await getEvents(), 5).filter((x) => x !== name)

	return suggestions.map((suggestion, i) => {
		const action = new vscode.CodeAction(
			vscode.l10n.t("Replace with `{0}`", suggestion),
			vscode.CodeActionKind.QuickFix
		)
		action.edit = new vscode.WorkspaceEdit()
		action.edit.replace(document.uri, diagnostic.range, suggestion)
		action.diagnostics = [diagnostic]
		action.isPreferred = i === 0

		return action
	})
}

class ForgeQuickFixProvider implements vscode.CodeActionProvider {
	async provideCodeActions(
		document: vscode.TextDocument,
		_range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext
	) {
		if (!getExtensionConfig().features.quickFixes) return []

		const actions: vscode.CodeAction[] = []
		const addAction = (action?: vscode.CodeAction) => {
			if (action) actions.push(action)
		}

		for (const diagnostic of context.diagnostics) {
			if (diagnostic.source !== DiagnosticSource) continue

			switch (getDiagnosticCode(diagnostic)) {
				case DiagnosticCode.InvalidOperatorOrder:
					addAction(fixInvalidOperatorOrder(document, diagnostic))
					break

				case DiagnosticCode.DuplicateOperator:
					addAction(fixDuplicateOperators(document, diagnostic))
					break

				case DiagnosticCode.MissingBrackets:
					addAction(fixMissingBrackets(document, diagnostic))
					break

				case DiagnosticCode.UnknownEvent:
					actions.push(...await fixUnknownEvent(document, diagnostic))
					break
			}
		}

		return actions
	}
}

/**
 * Registers the quick fixes for diagnostics.
 * @param ctx The extension context.
 */
export function registerQuickFixes(ctx: vscode.ExtensionContext) {
	ctx.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(Languages, new ForgeQuickFixProvider(), {
			providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
		})
	)
}