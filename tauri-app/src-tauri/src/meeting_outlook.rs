//! A deliberately narrow Outlook interface: create, save and display a new
//! draft. No sending, recipient resolution, mailbox reading or attachments.
#![allow(unsafe_op_in_unsafe_fn)]
use crate::AppError;
use serde_json::{Value, json};
use std::ptr;
use windows::{
    Win32::System::{
        Com::{CLSCTX_LOCAL_SERVER, CLSIDFromProgID, COINIT_APARTMENTTHREADED, CoCreateInstance,
            CoInitializeEx, CoUninitialize, DISPATCH_METHOD, DISPATCH_PROPERTYPUT, DISPPARAMS, IDispatch},
        Ole::DISPID_PROPERTYPUT,
        Variant::VARIANT,
    },
    core::{GUID, PCWSTR},
};

fn error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}

fn validate(subject: &str, html: &str) -> Result<(), AppError> {
    if subject.trim().is_empty() || subject.chars().count() > 255 || subject.chars().any(char::is_control)
        || html.is_empty() || html.len() > 4 * 1024 * 1024 {
        return Err(error("MEETING_MAIL_INVALID", "邮件标题或正文格式不正确，正文最多 4 MB。", None));
    }
    let tags = regex::Regex::new(r"(?s)<[^>]*>").unwrap();
    let unsafe_tag = regex::Regex::new(r"(?i)<\s*/?\s*(script|iframe|object|embed|form|input|link|img|svg|math)\b|\s(?:on[a-z]+|src|href)\s*=|url\s*\(").unwrap();
    if tags.find_iter(html).any(|tag| unsafe_tag.is_match(tag.as_str())) {
        return Err(error("MEETING_MAIL_INVALID", "邮件正文包含不支持的外部资源或活动内容。", None));
    }
    Ok(())
}

pub(crate) fn create_draft(subject: String, html: String) -> Result<Value, AppError> {
    validate(&subject, &html)?;
    std::thread::spawn(move || unsafe {
        let _apartment = Apartment::new()?;
        let mail = new_mail()?;
        fill_mail(&mail, &subject, &html)?;
        invoke(&mail, "Save", DISPATCH_METHOD, vec![])?;
        // A saved draft remains useful when Outlook cannot foreground its
        // editor. Report that result rather than encouraging duplicate drafts.
        let displayed = invoke(&mail, "Display", DISPATCH_METHOD, vec![false.into()]).is_ok();
        Ok(json!({"saved":true,"displayed":displayed,"message": if displayed {
            "已生成 Outlook 邮件草稿，请填写收件人并检查后发送。"
        } else {
            "邮件草稿已保存，未能自动打开，请在 Outlook 草稿箱查看。"
        }}))
    }).join().map_err(|_| error("MEETING_MAIL_FAILED", "生成 Outlook 邮件草稿的线程异常退出，请重试。", None))?
}

struct Apartment;
impl Apartment {
    unsafe fn new() -> Result<Self, AppError> {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().map_err(|e|
            error("MEETING_MAIL_FAILED", "无法初始化 Outlook 邮件组件。", Some(e.to_string())))?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) { unsafe { CoUninitialize(); } }
}

unsafe fn new_mail() -> Result<IDispatch, AppError> {
    let wide: Vec<u16> = "Outlook.Application\0".encode_utf16().collect();
    let unavailable = |e: windows::core::Error| error("OUTLOOK_UNAVAILABLE",
        "无法连接经典版 Microsoft Outlook，请确认已安装并完成账户配置。新版 Outlook 不支持此本机接口。", Some(e.to_string()));
    let clsid = CLSIDFromProgID(PCWSTR(wide.as_ptr())).map_err(unavailable)?;
    let outlook: IDispatch = CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER).map_err(unavailable)?;
    let item = invoke(&outlook, "CreateItem", DISPATCH_METHOD, vec![0i32.into()])?;
    IDispatch::try_from(&item).map_err(|e|
        error("MEETING_MAIL_FAILED", "Outlook 未能创建邮件草稿。", Some(e.to_string())))
}

unsafe fn fill_mail(mail: &IDispatch, subject: &str, html: &str) -> Result<(), AppError> {
    invoke(mail, "BodyFormat", DISPATCH_PROPERTYPUT, vec![2i32.into()])?;
    invoke(mail, "Subject", DISPATCH_PROPERTYPUT, vec![subject.into()])?;
    invoke(mail, "HTMLBody", DISPATCH_PROPERTYPUT, vec![html.into()])?;
    Ok(())
}

unsafe fn invoke(object: &IDispatch, name: &str, flags: windows::Win32::System::Com::DISPATCH_FLAGS, mut args: Vec<VARIANT>) -> Result<VARIANT, AppError> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let pointer = PCWSTR(wide.as_ptr());
    let mut id = 0;
    let failed = |e: windows::core::Error| error("MEETING_MAIL_FAILED",
        "Outlook 邮件草稿操作失败，请检查 Outlook 是否可用后重试。", Some(format!("{name}: {e}")));
    object.GetIDsOfNames(&GUID::zeroed(), &pointer, 1, 0x0409, &mut id).map_err(failed)?;
    args.reverse();
    let mut property = DISPID_PROPERTYPUT;
    let params = DISPPARAMS {
        rgvarg: if args.is_empty() { ptr::null_mut() } else { args.as_mut_ptr() },
        rgdispidNamedArgs: if flags == DISPATCH_PROPERTYPUT { &mut property } else { ptr::null_mut() },
        cArgs: args.len() as u32,
        cNamedArgs: if flags == DISPATCH_PROPERTYPUT { 1 } else { 0 },
    };
    let mut result = VARIANT::default();
    object.Invoke(id, &GUID::zeroed(), 0x0409, flags, &params, Some(&mut result), None, None).map_err(failed)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn meeting_mail_accepts_styled_chinese_but_rejects_active_html_and_bad_subjects() {
        assert!(validate("预算评审会议纪要", "<html><body><h1 style='font-family:Microsoft YaHei'>会议</h1><table><tr><td>张三</td></tr></table></body></html>").is_ok());
        for html in ["<script>alert(1)</script>", "<img src='https://example.com'>", "<p onclick='run()'>x</p>", "<div style='background:url(https://example.com)'>x</div>", "<a href='file:///C:/private'>x</a>"] {
            assert!(validate("会议纪要", html).is_err(), "{html}");
        }
        assert!(validate("注入\r\n收件人", "<p>正文</p>").is_err());
        assert!(validate("", "<p>正文</p>").is_err());
        assert!(validate("会议纪要", &"x".repeat(4 * 1024 * 1024 + 1)).is_err());
    }

    /// Saves a synthetic .msg to an explicitly supplied test path. Does not
    /// call Save/Display/Send or touch mailbox folders. No existing item read.
    #[test]
    #[ignore = "需要本机经典Outlook及指定的合成HTML与MSG路径，仅人工验收运行"]
    fn meeting_mail_outlook_sample_file() {
        let html_path = std::env::var("AUDIT_MEETING_SAMPLE_HTML").expect("指定合成HTML样例");
        let output = std::env::var("AUDIT_MEETING_SAMPLE_MSG").expect("指定样例MSG路径");
        assert!(!std::path::Path::new(&output).exists(), "不覆盖已有样例");
        let html = std::fs::read_to_string(html_path).unwrap();
        let subject = "季度审计项目协调会_会议纪要";
        validate(subject, &html).unwrap();
        std::thread::spawn(move || unsafe {
            let _apartment = Apartment::new().unwrap();
            let mail = new_mail().unwrap();
            fill_mail(&mail, subject, &html).unwrap();
            invoke(&mail, "SaveAs", DISPATCH_METHOD, vec![output.as_str().into(), 9i32.into()]).unwrap();
            let body = invoke(&mail, "HTMLBody", windows::Win32::System::Com::DISPATCH_PROPERTYGET, vec![]).unwrap();
            let body = windows::core::BSTR::try_from(&body).unwrap().to_string().to_lowercase();
            assert!(body.contains("microsoft yahei"));
            assert!(body.contains("<table"));
            drop(mail);
            use std::io::Read;
            let mut compound = cfb::open(&output).unwrap();
            let mut subject_bytes = Vec::new();
            compound.open_stream("/__substg1.0_0037001F").unwrap().read_to_end(&mut subject_bytes).unwrap();
            let subject_text = String::from_utf16(&subject_bytes.chunks_exact(2).map(|b| u16::from_le_bytes([b[0],b[1]])).collect::<Vec<_>>()).unwrap();
            assert_eq!(subject_text.trim_end_matches('\0'), subject);
            // MSG may store HTML either directly or encapsulated in compressed
            // RTF. Both are normal Outlook representations.
            assert!(compound.is_stream("/__substg1.0_10130102") || compound.is_stream("/__substg1.0_10090102"));
            assert!(!compound.walk().any(|entry| entry.path().to_string_lossy().contains("__recip_version1.0_")));
        }).join().unwrap();
    }
}
