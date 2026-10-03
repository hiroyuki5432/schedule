// この画面（タブ）を見分ける ID。サーバへの書き込みに X-Client-Id として付け、
// リアルタイム更新の通知に「どの画面からの変更か」として返ってくる。自分の画面の
// 変更は、保存した側がもう読み直しているので、通知では読み直さない（二度読みを防ぐ）。
//
// crypto.randomUUID は https / localhost でしか使えない（社内の http://<IP> では無い）
// ので、Math.random で作る。衝突しても「余計に1回読み直す／読み直さない」だけで済む。

function makeId(): string {
  let s = ''
  for (let i = 0; i < 4; i++) s += Math.floor(Math.random() * 0x100000000).toString(36)
  return s.slice(0, 20)
}

export const CLIENT_ID = makeId()
