# Harmor Web — Spectral Resynthesis Engine

ブラウザ上で動作する、加算合成・再合成ベースのピッチ編集エンジンです。
FL Studio Harmor の「スペクトル解析 → partial 追跡 → 加算合成」パイプラインを
静的 Web サイトとして実装しています。

---

## 特徴

| 機能 | 実装状況 |
|---|---|
| 音声ファイル読み込み (Web Audio decode) | ✅ |
| STFT スペクトル解析 (4096pt Hann窓) | ✅ |
| 放物線補間ピーク検出 (sub-bin精度) | ✅ |
| McAulay-Quatieri Partial 追跡 | ✅ |
| 対数周波数スペクトログラム表示 | ✅ |
| Partial トラック可視化 (カラー) | ✅ |
| グローバルピッチシフト (±24 半音) | ✅ |
| 選択範囲ローカルピッチシフト | ✅ |
| Partial 個別振幅編集 | ✅ |
| 位相連続加算合成 | ✅ |
| WAV エクスポート (16bit PCM) | ✅ |
| 元音源 / 再合成音 試聴比較 | ✅ |
| 時間軸ズーム (ホイール) | ✅ |
| Residual 成分保持 | 🔲 (将来実装) |
| ステレオ対応 | 🔲 (モノラルに downmix) |

---

## GitHub Pages への配置

```bash
# 1. リポジトリを作成 (Public)
git init
git remote add origin https://github.com/YOUR_NAME/harmor-web.git

# 2. ファイルをコミット (このディレクトリごと)
git add .
git commit -m "Initial release"
git push -u origin main

# 3. Settings → Pages → Branch: main / root (/) を選択
# → https://YOUR_NAME.github.io/harmor-web/ でアクセス可能
```

ビルド不要。HTML/CSS/JS をそのままリポジトリのルートに置くだけ。

---

## ファイル構成

```
harmor-web/
├── index.html          メインUI
├── css/
│   └── style.css       DAW風ダークテーマ
└── js/
    ├── fft.js          Cooley-Tukey FFT (純粋 JS, 依存ゼロ)
    ├── analysis.js     STFT + ピーク検出 + Partial 追跡
    ├── synthesis.js    加算合成エンジン
    ├── renderer.js     Canvas 可視化 (スペクトログラム/Partial/UI)
    ├── audio.js        AudioContext 管理 + 再生
    ├── export.js       WAV エクスポート
    └── app.js          アプリコントローラ
```

---

## アルゴリズム詳細

### 解析パイプライン

```
audio (Float32) → STFT frames (Hann 4096, hop 512)
→ 各フレームで FFT → 複素スペクトル
→ 放物線補間ピーク検出 (log-magnitude 空間, 閾値 -70 dBFS)
→ McAulay-Quatieri 追跡 (相対周波数誤差 5% 以内でマッチング)
→ Partial リスト [{id, segs:[{fi, freq, amp, phase}]}]
```

### 再合成パイプライン

```
Partial リスト + pitchMap(fi, freq→ratio) + ampMap(id→scale)
→ 各 Partial を f1→f2, a1→a2 で線形補間しながら
   phase += 2π·freq/sr (連続位相蓄積)
→ out[sample] += amp · sin(phase)
→ 全 Partial を加算 → 正規化 → Float64Array
→ WAV (16bit PCM) or AudioBuffer for playback
```

### ピッチ変換の原理

- `再生速度変更 (time-stretch)` は **一切使用しない**
- Partial の周波数を `freq_new = freq_orig × 2^(semitones/12)` にリマッピング
- 位相は新しい周波数で再積分するため、位相連続性は自動的に保たれる
- これは Harmor が "Image Synthesis" モードで行う動作と等価

---

## 既知の制限

| 項目 | 現状の限界 |
|---|---|
| Residual (ノイズ/擦れ音) | 未実装。声/楽器の倍音成分のみ再合成 |
| Polyphonic F0 推定 | MQ アルゴリズムは単音/少音源に最適 |
| 処理速度 | 30秒 @ 44100Hz ≈ 5-10秒の解析時間 (JS制約) |
| 位相リセット精度 | Birth フレームの位相は解析値をそのまま使用 |
| ステレオ | モノラル downmix のみ |

---

## 将来の拡張ポイント

1. **Residual 再合成**: STFT スペクトルから Partial 寄与を減算し、
   残差を帯域フィルタ済みノイズとして加算 (SMS モデルの完全実装)

2. **Web Worker 並列化**: 解析・合成を Worker スレッドで実行し UI スレッドを解放

3. **AudioWorklet リアルタイム合成**: OfflineAudioContext で非同期 Partial 合成

4. **F0 自動検出 (HPS)**: Harmonic Product Spectrum で基音を推定し
   ノート編集グリッドを重畳

5. **MIDI ノートグリッド**: F0 推定結果から自動で音符を生成、
   音符単位のピッチ編集 UI

6. **Mid/Side 分離**: ステレオ入力を Mid + Side に分離して個別処理

7. **エンベロープ編集**: 各 Partial の時間振幅カーブをドラッグ編集
