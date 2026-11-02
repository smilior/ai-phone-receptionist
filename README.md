# AI電話受付（Twilio + Gemini Live + Cloudflare Workers）

電子書籍『うちの電話、AIに任せています』のサンプルコードです。
Twilioにかかってきた電話を、Gemini Live（音声AI）が架空のお店「AI食堂うみべ」の受付として応対します。

コピー用ページ: https://smilior.github.io/ai-phone-receptionist/

## 必要なもの
- Node.js 18以上
- Cloudflareアカウント（無料プランでOK）
- Gemini APIキー（Google AI Studio で取得）
- Twilioアカウントと電話番号

## セットアップ
```bash
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

デプロイ後に表示されるURL（例: `https://ai-phone.<あなたのサブドメイン>.workers.dev`）の末尾に `/twiml` を付けて、
Twilioコンソールの「電話番号 → Voice Configuration → A call comes in（Webhook）」に貼り付けて保存します。

例: `https://ai-phone.xxxx.workers.dev/twiml`

あとはその電話番号に電話をかけるだけです。

## ファイル構成
- `src/index.js` … Worker本体（Twilio Media Streams ⇔ Gemini Live の中継）
- `src/prompt.js` … AIへの指示（お店の設定）
- `public/index.html` … トップページ
- `wrangler.jsonc` … Cloudflare Workers の設定
- `package.json`

## ライセンス
MIT
