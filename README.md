# Stick Bugged Generator

任意の画像から "Get Stick Bugged Lol" 動画を作る、ブラウザだけで動く Web アプリです。画像はどこにも送信しません。

[n0spaces/get-stick-bugged-lol](https://github.com/n0spaces/get-stick-bugged-lol)（Python）のアルゴリズムと演出の時間配分を、TypeScript で移植しています。

## 機能

- 線分検出（LSD）と、輪郭に沿った9本の自動選択（線どうしの間隔、輪郭の強さの重み）
- 9本の手動調整（端点のドラッグ、候補への差し替え、手描き、順番の入れ替え）
- 変形区間の長さの調整。音声はピッチを保ったまま縮める（WSOLA / 中抜き）
- プレビュー再生と、MP4（H.264 + AAC）/ WebM（VP9 + Opus）の書き出し（WebCodecs）

詳しい仕様は [SPEC.md](SPEC.md) にあります。

## 使い方

### 1. 素材を用意する

棒虫の動画と効果音は権利上このリポジトリに含めていません。gsbl のリポジトリから取得して `public/media/` に置いてください。

```bash
git clone --depth 1 https://github.com/n0spaces/get-stick-bugged-lol gsbl
mkdir -p public/media
cp gsbl/gsbl/media/* public/media/
```

必要なファイル: `stick_bug.mp4`、`note0.wav`〜`note9.wav`、`transform.wav`

### 2. 起動する

```bash
npm install
npm run dev
```

ブラウザで http://localhost:5173 を開き、画像をドロップします。

### その他のコマンド

```bash
npm test        # LSD・音声伸縮・線分選択のテスト
npm run build   # dist/ に静的ファイルを出力
```

## 対応ブラウザ

WebCodecs が使える最近の Chrome / Edge / Safari。

## ライセンス

[GNU Affero General Public License v3.0 以降](LICENSE)。

`src/lsd.ts` は LSD 1.6（Rafael Grompone von Gioi ほか、Image Processing On Line 2012、DOI:10.5201/ipol.2012.gjmr-lsd、AGPL-3.0）の移植です。`test/fixtures/` の `chairs.pgm` と `chairs.lsd.txt` も同じ配布物に含まれていたものです。
