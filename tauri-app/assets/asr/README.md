# 套餐 HTTP ASR 连接测试样音

`connection-test.wav` 为 Windows 自带 Microsoft Huihui Desktop 合成的「语音测试」，16 kHz、单声道、16 位 PCM WAV，约 1.8 秒。它不含用户录音或密钥，经 `include_bytes!` 嵌入 EXE，运行时不依赖语音合成或外部文件。

仅在设置页使用 `qwen-audio-3.0-asr-flash` 点击「测试套餐通道」时发送，实际调用识别服务并消耗少量套餐额度；HTTP 请求成功且返回非空文字才算通过。静音样音可能被服务以 HTTP 400 拒绝，因此使用可识别的短语音。

重新生成时使用 PowerShell 7 的 `System.Speech.Synthesis.SpeechSynthesizer`，选择 `Microsoft Huihui Desktop`，输出格式设为 16000 Hz / Sixteen / Mono，调用 `Speak('语音测试')`。
