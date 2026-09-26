//! 本机 WASAPI 录音链路探针：手动诊断用（默认 ignored，不进常规回归）。
//!
//! 运行方式：
//! `cargo test --manifest-path src-tauri/Cargo.toml --test audio_probe -- --ignored --nocapture`

#![cfg(windows)]

use std::time::Instant;
use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

fn probe(device_direction: Direction, label: &str) {
    let started = Instant::now();
    let hr = wasapi::initialize_mta();
    println!("[{label}] initialize_mta -> {:?}", hr);
    let enumerator = match DeviceEnumerator::new() {
        Ok(value) => value,
        Err(error) => {
            println!("[{label}] 枚举器创建失败: {error:?}");
            return;
        }
    };
    let device = match enumerator.get_default_device(&device_direction) {
        Ok(value) => value,
        Err(error) => {
            println!("[{label}] 默认设备获取失败: {error:?}");
            return;
        }
    };
    println!(
        "[{label}] 默认设备: {:?}（耗时 {:?}）",
        device.get_friendlyname(),
        started.elapsed()
    );
    let mut client = match device.get_iaudioclient() {
        Ok(value) => value,
        Err(error) => {
            println!("[{label}] IAudioClient 获取失败: {error:?}");
            return;
        }
    };
    let format = WaveFormat::new(16, 16, &SampleType::Int, 16_000, 1, None);
    let init_started = Instant::now();
    match client.initialize_client(
        &format,
        &Direction::Capture,
        &StreamMode::PollingShared {
            autoconvert: true,
            buffer_duration_hns: 2_000_000,
        },
    ) {
        Ok(()) => {
            println!(
                "[{label}] 16kHz 单声道初始化成功，初始化耗时 {:?}",
                init_started.elapsed()
            );
        }
        Err(error) => {
            println!(
                "[{label}] 16kHz 单声道初始化失败（初始化耗时 {:?}）: {error:?}",
                init_started.elapsed(),
            );
            let mix = match client.get_mixformat() {
                Ok(value) => value,
                Err(error) => {
                    println!("[{label}] 混合格式获取失败: {error:?}");
                    return;
                }
            };
            println!(
                "[{label}] 设备混合格式: {} Hz / {} 声道 / {} 位",
                mix.get_samplespersec(),
                mix.get_nchannels(),
                mix.get_bitspersample()
            );
            match client.initialize_client(
                &mix,
                &Direction::Capture,
                &StreamMode::PollingShared {
                    autoconvert: false,
                    buffer_duration_hns: 2_000_000,
                },
            ) {
                Ok(()) => println!("[{label}] 混合格式回退初始化成功"),
                Err(fallback) => println!("[{label}] 混合格式回退也失败: {fallback:?}"),
            }
        }
    }
    println!("[{label}] 总耗时 {:?}", started.elapsed());
}

#[test]
#[ignore = "需要真实音频设备，仅手动诊断运行"]
fn audio_device_probe() {
    probe(Direction::Render, "回环-系统声音");
    probe(Direction::Capture, "采集-麦克风");
}
