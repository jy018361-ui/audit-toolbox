//! Local cardinal orientation detection. Only an unambiguous OCR score may
//! change pixels; page aspect ratio never decides document orientation.
//! Windows OCR is built into Windows and does not upload document contents.
use crate::ocr_store::PageMetadata;
use image::DynamicImage;

#[derive(Clone, Copy, Debug, Default)]
struct Candidate {
    rotation: u16,
    score: f64,
    characters: usize,
}

pub(crate) struct Correction {
    pub image: DynamicImage,
    pub metadata: PageMetadata,
    pub warning: Option<String>,
    pub reference_characters: usize,
}

fn rotate(image: &DynamicImage, clockwise: u16) -> DynamicImage {
    match clockwise {
        90 => image.rotate90(),
        180 => image.rotate180(),
        270 => image.rotate270(),
        _ => image.clone(),
    }
}

/// OCR has no confidence field. Count readable text in coherent lines, favor
/// letters over digits (tables of numbers are poor evidence of up/down), and
/// discount results the recognizer itself says are still tilted/sideways.
fn text_score(lines: &[String], angle: Option<f64>) -> f64 {
    let mut score = 0.0;
    for line in lines {
        let letters = line.chars().filter(|c| c.is_alphabetic()).count();
        let digits = line.chars().filter(|c| c.is_ascii_digit()).count();
        if letters >= 2 {
            score += letters as f64 + digits.min(letters) as f64 * 0.2;
            if letters >= 6 { score += 3.0; }
        } else {
            score += letters as f64 * 0.15 + digits as f64 * 0.05;
        }
    }
    let upright = angle.is_none_or(|angle| {
        let normalized = angle.rem_euclid(360.0);
        normalized <= 15.0 || normalized >= 345.0
    });
    if upright { score } else { score * 0.1 }
}

fn select(candidates: &[Candidate; 4]) -> (u16, &'static str) {
    let mut ordered = *candidates;
    ordered.sort_by(|a, b| b.score.total_cmp(&a.score));
    let best = ordered[0];
    let runner_up = ordered[1].score;
    // Ambiguous/blank/number-only pages retain their existing orientation.
    if best.score < 18.0 || best.score - runner_up < 8.0 || best.score < runner_up * 1.25 {
        return (0, "uncertain");
    }
    (best.rotation, "detected")
}

pub(crate) fn correct(image: &DynamicImage) -> Correction {
    match native_candidates(image) {
        Ok(candidates) => {
            let (rotation, status) = select(&candidates);
            Correction {
                image: rotate(image, rotation),
                metadata: PageMetadata { auto_rotation: rotation, auto_orientation_status: status.into() },
                warning: (status == "uncertain").then(|| "页面方向判断不充分，已保留原方向；请结合原扫描件核对识别结果。".into()),
                reference_characters: candidates.iter().find(|c| c.rotation == rotation).map_or(0, |c| c.characters),
            }
        }
        Err(()) => Correction {
            image: image.clone(),
            metadata: PageMetadata { auto_rotation: 0, auto_orientation_status: "unavailable".into() },
            warning: Some("本机自动方向检测不可用（可能缺少 Windows OCR 语言包），已按原方向识别，请核对结果。".into()),
            reference_characters: 0,
        },
    }
}

#[cfg(windows)]
fn native_candidates(image: &DynamicImage) -> Result<[Candidate; 4], ()> {
    use windows::{
        Globalization::Language,
        Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap},
        Media::Ocr::OcrEngine,
        Storage::Streams::DataWriter,
        Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize},
    };
    // Workers are background threads; balance only a successful initialization.
    struct Apartment(bool);
    impl Drop for Apartment {
        fn drop(&mut self) { if self.0 { unsafe { RoUninitialize() }; } }
    }
    let _apartment = Apartment(unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok());
    let run = || -> windows::core::Result<[Candidate; 4]> {
        // Chinese and mixed English business documents are the default. Fall
        // back to the user's installed language without installing anything.
        let engine = Language::CreateLanguage(&windows::core::HSTRING::from("zh-Hans"))
            .and_then(|language| OcrEngine::TryCreateFromLanguage(&language))
            .or_else(|_| OcrEngine::TryCreateFromUserProfileLanguages())
            .or_else(|_| {
                let languages = OcrEngine::AvailableRecognizerLanguages()?;
                OcrEngine::TryCreateFromLanguage(&languages.GetAt(0)?)
            })?;
        let limit = OcrEngine::MaxImageDimension()?.min(2200);
        if limit == 0 { return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x80004005u32 as i32))); }
        let probe = if image.width().max(image.height()) > limit {
            image.thumbnail(limit, limit)
        } else { image.clone() };
        let mut candidates = [Candidate::default(); 4];
        for (index, rotation) in [0, 90, 180, 270].into_iter().enumerate() {
            let pixels = rotate(&probe, rotation).to_luma8();
            let writer = DataWriter::new()?;
            writer.WriteBytes(pixels.as_raw())?;
            let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
                &writer.DetachBuffer()?, BitmapPixelFormat::Gray8,
                pixels.width() as i32, pixels.height() as i32,
            )?;
            let result = engine.RecognizeAsync(&bitmap)?.get()?;
            let mut lines = Vec::new();
            for line in result.Lines()? { lines.push(line.Text()?.to_string()); }
            let angle = result.TextAngle().and_then(|value| value.Value()).ok();
            candidates[index] = Candidate { rotation, score: text_score(&lines, angle),
                characters: lines.iter().flat_map(|line| line.chars()).filter(|c| !c.is_whitespace()).count() };
            bitmap.Close()?;
            writer.Close()?;
        }
        Ok(candidates)
    };
    run().map_err(|_| ())
}

#[cfg(not(windows))]
fn native_candidates(_: &DynamicImage) -> Result<[Candidate; 4], ()> { Err(()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chooses_only_clear_cardinal_winner() {
        for (index, expected) in [0, 90, 180, 270].into_iter().enumerate() {
            let mut scores = [Candidate::default(); 4];
            for (i, rotation) in [0, 90, 180, 270].into_iter().enumerate() {
                scores[i] = Candidate { rotation, score: if i == index { 80.0 } else { 12.0 }, ..Default::default() };
            }
            assert_eq!(select(&scores), (expected, "detected"));
        }
    }
    #[test]
    fn blank_number_only_and_ambiguous_pages_keep_original_direction() {
        for scores in [[0.0; 4], [4.0, 9.0, 3.0, 2.0], [80.0, 86.0, 0.0, 0.0], [80.0, 94.0, 0.0, 0.0]] {
            let candidates = std::array::from_fn(|index| Candidate { rotation: index as u16 * 90, score: scores[index], ..Default::default() });
            assert_eq!(select(&candidates), (0, "uncertain"));
        }
        assert!(text_score(&["12345678901234567890".into()], None) < 18.0);
    }
    #[test]
    fn coherent_text_beats_fragments_and_reported_sideways_text() {
        let text = vec!["采购合同编号 Purchase contract ABC2026".into(), "合同金额人民币100000元".into()];
        let coherent = text_score(&text, Some(0.0));
        assert!(coherent > 18.0);
        assert!(text_score(&text, Some(90.0)) < coherent * 0.2);
        assert!(text_score(&text, Some(180.0)) < coherent * 0.2);
        assert_eq!(text_score(&text, Some(359.0)), coherent);
    }
    #[test]
    fn pixel_rotation_is_clockwise_and_does_not_modify_source() {
        let source = DynamicImage::ImageLuma8(image::GrayImage::from_raw(2, 3, vec![1,2,3,4,5,6]).unwrap());
        assert_eq!(rotate(&source, 90).to_luma8().as_raw(), &[5,3,1,6,4,2]);
        assert_eq!(rotate(&source, 180).to_luma8().as_raw(), &[6,5,4,3,2,1]);
        assert_eq!(rotate(&source, 270).to_luma8().as_raw(), &[2,4,6,1,3,5]);
        assert_eq!(source.to_luma8().as_raw(), &[1,2,3,4,5,6]);
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "需要本机安装 Windows OCR 语言包；使用 --ignored 显式验收"]
    fn native_ocr_corrects_real_synthetic_text_in_all_four_directions() {
        // Original fixture is authored locally with Windows fonts; contains no
        // user document. This exercises native OCR rather than mocking scores.
        let source = image::load_from_memory(include_bytes!("../../tests/fixtures/ocr_orientation.png")).unwrap();
        for (rotation, expected) in [(0, 0), (90, 270), (180, 180), (270, 90)] {
            let input = rotate(&source, rotation);
            let scores = native_candidates(&input).expect("本机需安装 Windows OCR 语言包以运行原生方向验收");
            eprintln!("input={rotation} candidates={scores:?}");
            assert_eq!(select(&scores), (expected, "detected"));
        }
    }
}
