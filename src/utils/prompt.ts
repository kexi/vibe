/**
 * インタラクティブプロンプトユーティリティ
 */

/**
 * ユーザーから1行の入力を読み取る
 */
async function readLine(): Promise<string> {
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  const isInputReceived = n !== null;
  if (isInputReceived) {
    return new TextDecoder().decode(buf.subarray(0, n)).trim();
  }
  return "";
}

/**
 * Y/n形式の確認プロンプトを表示する
 * @param message 確認メッセージ
 * @returns ユーザーがYesを選択した場合true、それ以外はfalse
 */
export async function confirm(message: string): Promise<boolean> {
  while (true) {
    console.log(`${message}`);
    const input = await readLine();

    const isYes = input === "Y" || input === "y" || input === "";
    if (isYes) {
      return true;
    }

    const isNo = input === "N" || input === "n";
    if (isNo) {
      return false;
    }

    console.log("無効な入力です。Y/y/n/N のいずれかを入力してください。");
  }
}

/**
 * 選択肢から番号で選択するプロンプトを表示する
 * @param message プロンプトメッセージ
 * @param choices 選択肢の配列
 * @returns 選択されたインデックス(0始まり)
 */
export async function select(
  message: string,
  choices: string[],
): Promise<number> {
  while (true) {
    console.log(`${message}`);
    for (let i = 0; i < choices.length; i++) {
      console.log(`  ${i + 1}. ${choices[i]}`);
    }
    console.log("選択してください (番号を入力):");

    const input = await readLine();
    const number = parseInt(input, 10);

    const isValidNumber = !isNaN(number) && number >= 1 && number <= choices.length;
    if (isValidNumber) {
      return number - 1;
    }

    console.log(`無効な入力です。1〜${choices.length} の番号を入力してください。`);
  }
}
