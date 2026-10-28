# 会议音视频解码合成样例

本目录只含合成的半秒蓝色视频／440 Hz 正弦音，不含真实会议、文字、密钥或个人信息。Rust 回归直接读取这些已生成文件，通过 Windows Media Foundation 解码，不调用云端、不需要 FFmpeg 或 Python。

- `tone.mp4`、`tone.mov`：H.264 蓝色视频＋AAC 音轨。
- `tone.wmv`：WMV2 蓝色视频＋WMA2 音轨。
- `tone.avi`：MJPEG 蓝色视频＋16 位 PCM 音轨。
- `tone.webm`：VP8 蓝色视频＋Opus 音轨；实际解码能力取决于 Windows 安装的媒体解码器，属于显式执行的可选测试。
- `tone.mp3`、`tone.m4a`、`tone.aac`、`tone.flac`：同样的合成声音；FLAC 同属可选系统解码器测试。
- `no-audio.mp4`：只有 H.264 视频，没有音轨，验证本地友好报错。

这些小文件在开发时预生成。需要更新样例时，可用 FFmpeg 的 `color=c=blue:s=16x16:r=10:d=0.5` 和 `sine=frequency=440:sample_rate=16000:duration=0.5` 测试源，选择上述编码；WMA 使用 44100 Hz，Opus 使用 48000 Hz。FFmpeg 仅用于开发时生成固定测试资源，不参与应用运行或测试执行。
