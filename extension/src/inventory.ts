import * as vscode from "vscode";

const INTERESTING =
  /(cursor|composer|aichat|agent|chat|submit|prompt|voice|generation)/i;

export type InventoryReport = {
  generatedAt: string;
  totalCommands: number;
  matched: string[];
  interestingGroups: Record<string, string[]>;
};

export async function inventoryAgentCommands(): Promise<InventoryReport> {
  const all = await vscode.commands.getCommands(true);
  const matched = all.filter((id) => INTERESTING.test(id)).sort();

  const groups: Record<string, string[]> = {
    composer: [],
    aichat: [],
    agent: [],
    chat: [],
    cursor: [],
    submit: [],
    other: [],
  };

  for (const id of matched) {
    if (id.startsWith("composer.")) groups.composer.push(id);
    else if (id.startsWith("aichat.") || id.includes("aichat")) groups.aichat.push(id);
    else if (id.includes("agent")) groups.agent.push(id);
    else if (id.includes("chat")) groups.chat.push(id);
    else if (id.startsWith("cursor.") || id.includes("cursor")) groups.cursor.push(id);
    else if (id.includes("submit") || id.includes("prompt")) groups.submit.push(id);
    else groups.other.push(id);
  }

  return {
    generatedAt: new Date().toISOString(),
    totalCommands: all.length,
    matched,
    interestingGroups: groups,
  };
}

export async function writeInventoryMarkdown(
  file: vscode.Uri,
  report: InventoryReport,
): Promise<void> {
  const lines: string[] = [
    "# Spike command inventory",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Total commands: ${report.totalCommands}`,
    `Matched candidates: ${report.matched.length}`,
    "",
  ];

  for (const [group, ids] of Object.entries(report.interestingGroups)) {
    lines.push(`## ${group} (${ids.length})`, "");
    if (!ids.length) {
      lines.push("_none_", "");
      continue;
    }
    for (const id of ids) lines.push(`- \`${id}\``);
    lines.push("");
  }

  lines.push("## All matched", "");
  for (const id of report.matched) lines.push(`- \`${id}\``);
  lines.push("");

  const encoder = new TextEncoder();
  const dir = vscode.Uri.joinPath(file, "..");
  try {
    await vscode.workspace.fs.createDirectory(dir);
  } catch {
    // directory may already exist
  }
  await vscode.workspace.fs.writeFile(file, encoder.encode(lines.join("\n")));
}
