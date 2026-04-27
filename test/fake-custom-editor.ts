export function fakeMatchesKey(data: string, keyId: string): boolean {
  switch (keyId) {
    case "backspace":
      return data === "\x7f" || data === "\x08";
    case "left":
      return data === "\x1b[D";
    case "right":
      return data === "\x1b[C";
    case "up":
      return data === "\x1b[A";
    case "down":
      return data === "\x1b[B";
    case "home":
      return data === "\x1b[H";
    case "end":
      return data === "\x1b[F";
    case "pageUp":
      return data === "\x1b[5~";
    case "pageDown":
      return data === "\x1b[6~";
    case "delete":
      return data === "\x1b[3~";
    case "insert":
      return data === "\x1b[2~";
    case "enter":
    case "return":
      return data === "\n" || data === "\r";
    case "tab":
      return data === "\t";
    case "escape":
      return data === "\x1b";
    default:
      return false;
  }
}

export class FakeCustomEditor {
  text = "";
  cursorIndex = 0;
  autocompleteVisible = false;
  handledInputs: string[] = [];

  constructor(_tui: unknown, _theme: unknown, _keybindings: unknown, _options?: unknown) {}

  handleInput(data: string): void {
    this.handledInputs.push(data);

    if (fakeMatchesKey(data, "backspace")) {
      this.deleteBackward();
      return;
    }

    if (fakeMatchesKey(data, "left")) {
      this.cursorIndex = Math.max(0, this.cursorIndex - 1);
      return;
    }

    if (fakeMatchesKey(data, "right")) {
      this.cursorIndex = Math.min(this.text.length, this.cursorIndex + 1);
      return;
    }

    if (fakeMatchesKey(data, "up")) {
      this.moveVertical(-1);
      return;
    }

    if (fakeMatchesKey(data, "down")) {
      this.moveVertical(1);
      return;
    }

    if (fakeMatchesKey(data, "home")) {
      const { line } = this.getCursor();
      this.setCursorPosition(line, 0);
      return;
    }

    if (fakeMatchesKey(data, "end")) {
      const { line } = this.getCursor();
      const lineText = this.getLines()[line] ?? "";
      this.setCursorPosition(line, lineText.length);
      return;
    }

    if (fakeMatchesKey(data, "enter") || fakeMatchesKey(data, "return")) {
      this.insertTextAtCursor("\n");
      return;
    }

    if (fakeMatchesKey(data, "tab")) {
      this.insertTextAtCursor("\t");
      return;
    }

    if (data.startsWith("\x1b")) {
      return;
    }

    this.insertTextAtCursor(data);
  }

  getText(): string {
    return this.text;
  }

  getCursor(): { line: number; col: number } {
    const beforeCursor = this.text.slice(0, this.cursorIndex).split("\n");
    return {
      line: beforeCursor.length - 1,
      col: beforeCursor[beforeCursor.length - 1]?.length ?? 0,
    };
  }

  insertTextAtCursor(text: string): void {
    this.text = `${this.text.slice(0, this.cursorIndex)}${text}${this.text.slice(this.cursorIndex)}`;
    this.cursorIndex += text.length;
  }

  setText(text: string): void {
    this.text = text;
    this.cursorIndex = text.length;
  }

  setCursorPosition(line: number, col: number): void {
    const lines = this.getLines();
    const safeLine = Math.max(0, Math.min(line, Math.max(lines.length - 1, 0)));
    const safeCol = Math.max(0, Math.min(col, (lines[safeLine] ?? "").length));

    let index = 0;
    for (let currentLine = 0; currentLine < safeLine; currentLine += 1) {
      index += (lines[currentLine] ?? "").length + 1;
    }

    this.cursorIndex = index + safeCol;
  }

  isShowingAutocomplete(): boolean {
    return this.autocompleteVisible;
  }

  private getLines(): string[] {
    return this.text.split("\n");
  }

  private deleteBackward(): void {
    if (this.cursorIndex === 0) {
      return;
    }

    this.text = `${this.text.slice(0, this.cursorIndex - 1)}${this.text.slice(this.cursorIndex)}`;
    this.cursorIndex -= 1;
  }

  private moveVertical(direction: -1 | 1): void {
    const { line, col } = this.getCursor();
    const lines = this.getLines();
    const targetLine = Math.max(0, Math.min(line + direction, lines.length - 1));
    const targetCol = Math.min(col, (lines[targetLine] ?? "").length);
    this.setCursorPosition(targetLine, targetCol);
  }
}

export function typeText(editor: { handleInput(data: string): void }, text: string): void {
  for (const char of text) {
    editor.handleInput(char);
  }
}
