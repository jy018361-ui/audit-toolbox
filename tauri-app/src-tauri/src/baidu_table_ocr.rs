//! Baidu table V2 uses zero-based grid lines; end lines are exclusive.
//! https://ai.baidu.com/ai-doc/OCR/Al1zvpylt
use crate::AppError;
use reqwest::blocking::{Client, Response};
use serde_json::{Value, json};
use std::time::Duration;

pub(crate) fn recognize(image: &str, key: &str, secret: &str) -> Result<Value, AppError> {
    recognize_at(image, key, secret, "https://aip.baidubce.com")
}

fn recognize_at(image: &str, key: &str, secret: &str, base: &str) -> Result<Value, AppError> {
    let client=Client::builder().timeout(Duration::from_secs(90)).build().map_err(network_failure)?;
    let token=read_response(client.post(format!("{base}/oauth/2.0/token"))
        .query(&[("grant_type","client_credentials"),("client_id",key),("client_secret",secret)])
        .send().map_err(network_failure)?)?;
    let access=token["access_token"].as_str().filter(|value|!value.trim().is_empty())
        .ok_or_else(||AppError::new("OCR_TOKEN_FAILED","百度表格 OCR 鉴权失败，请检查当前 OCR 来源的 API Key 和 Secret Key。",true,None))?;
    let value=read_response(client.post(format!("{base}/rest/2.0/ocr/v1/table"))
        .query(&[("access_token",access)])
        .form(&[("image",image),("return_excel","false")])
        .send().map_err(network_failure)?)?;
    if let Some(code)=value.get("error_code").filter(|code|!code.is_null()) {
        let code=code.as_u64().or_else(||code.as_str().and_then(|value|value.parse().ok()));
        let reason=match code {
            Some(6)=>"当前百度应用没有表格文字识别V2权限，请在百度控制台为当前应用开通该接口。",
            Some(17|19)=>"当前百度表格识别额度已用完，请检查该接口的可用额度。",
            Some(18)=>"百度表格识别请求过于频繁，请稍后重试。",
            Some(110|111)=>"百度表格识别凭据已失效，请检查当前 OCR 来源的配置后重试。",
            _=>"请检查百度表格文字识别V2的接口权限、额度或稍后重试。",
        };
        return Err(AppError::new("BAIDU_TABLE_REQUEST_FAILED",format!("百度表格识别失败{}。{reason}",code.map(|value|format!("（错误码 {value}）")).unwrap_or_default()),true,None));
    }
    let text=table_result_html(&value)?;
    Ok(json!({"text":text,"engine":"baidu"}))
}

fn network_failure(failure: reqwest::Error) -> AppError {
    // Token requests carry credentials in the URL. Never retain that URL.
    AppError::new("BAIDU_TABLE_NETWORK_ERROR","百度表格识别网络请求失败，请检查网络后重试。",true,Some(failure.without_url().to_string()))
}

fn read_response(response: Response) -> Result<Value, AppError> {
    if !response.status().is_success() {
        return Err(AppError::new("BAIDU_TABLE_HTTP_ERROR",format!("百度表格识别服务返回 HTTP {}，请检查接口权限或稍后重试。",response.status().as_u16()),true,None));
    }
    response.json().map_err(|_|AppError::new("BAIDU_TABLE_RESPONSE_INVALID","百度表格识别未返回有效 JSON，请稍后重试。",true,None))
}

fn invalid(message: &str) -> AppError {
    AppError::new("BAIDU_TABLE_INVALID", format!("百度表格识别结果无法可靠还原：{message}"), true, None)
}

fn escaped(text: &str) -> String {
    text.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;").replace('\'',"&#39;")
        .replace("\r\n","\n").replace('\r',"\n").replace('\n',"<br>")
}

fn notes(html: &mut String, value: Option<&Value>) -> Result<(), AppError> {
    if let Some(value)=value {
        for note in value.as_array().ok_or_else(||invalid("表头或表尾结构无效。"))? {
            let words=note["words"].as_str().ok_or_else(||invalid("表头或表尾缺少文字。"))?;
            if !words.is_empty() {html.push_str(&format!("<p>{}</p>",escaped(words)));}
        }
    }
    Ok(())
}

fn table_result_html(value: &Value) -> Result<String, AppError> {
    let tables=value["tables_result"].as_array().filter(|tables|!tables.is_empty()&&tables.len()<=10_000)
        .ok_or_else(||invalid("未返回完整表格，请核对原页或更换表格识别引擎。"))?;
    if value["table_num"].as_u64()!=Some(tables.len() as u64) {return Err(invalid("表格数量与返回内容不一致。"));}
    let mut html=String::new();
    let mut total_slots=0usize;
    for table in tables {
        let body=table["body"].as_array().filter(|body|!body.is_empty()).ok_or_else(||invalid("缺少单元格。"))?;
        let mut cells=Vec::new();
        let (mut height,mut width)=(0usize,0usize);
        for cell in body {
            let read=|key:&str|cell[key].as_u64().and_then(|value|usize::try_from(value).ok()).ok_or_else(||invalid("单元格行列编号无效。"));
            let (r0,r1,c0,c1)=(read("row_start")?,read("row_end")?,read("col_start")?,read("col_end")?);
            if r1<=r0||c1<=c0||r1>20_000||c1>512 {return Err(invalid("单元格行列或合并范围无效。"));}
            let words=cell["words"].as_str().ok_or_else(||invalid("单元格缺少文字字段，不能推断为空白格。"))?;
            height=height.max(r1);width=width.max(c1);
            cells.push((r0,r1,c0,c1,words));
        }
        total_slots+=height*width;
        if total_slots>1_000_000 {return Err(invalid("表格规模超出有效范围。"));}
        let mut slots=vec![None; height*width];
        for (index,&(r0,r1,c0,c1,_)) in cells.iter().enumerate() {
            for row in r0..r1 {for col in c0..c1 {
                if slots[row*width+col].replace(index).is_some() {return Err(invalid("单元格或合并范围重叠。"));}
            }}
        }
        if slots.iter().any(Option::is_none) {return Err(invalid("存在未返回的单元格，不能补空格或移动金额列。"));}
        notes(&mut html,table.get("header"))?;
        html.push_str("<table>");
        for row in 0..height {
            html.push_str("<tr>");
            for col in 0..width {
                let (r0,r1,c0,c1,words)=cells[slots[row*width+col].unwrap()];
                if row!=r0||col!=c0 {continue;}
                html.push_str("<td");
                if r1-r0>1 {html.push_str(&format!(" rowspan=\"{}\"",r1-r0));}
                if c1-c0>1 {html.push_str(&format!(" colspan=\"{}\"",c1-c0));}
                html.push('>');html.push_str(&escaped(words));html.push_str("</td>");
            }
            html.push_str("</tr>");
        }
        html.push_str("</table>");
        notes(&mut html,table.get("footer"))?;
    }
    Ok(html)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cell(row: u64, col: u64, words: &str) -> Value {
        json!({"row_start":row,"row_end":row+1,"col_start":col,"col_end":col+1,"words":words})
    }
    fn response(body: Vec<Value>) -> Value {
        json!({"table_num":1,"tables_result":[{"header":[],"body":body,"footer":[]}]})
    }
    fn server(replies: Vec<(u16,Value)>) -> (String,std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read,Write};
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let task=std::thread::spawn(move||{
            let mut requests=Vec::new();
            for (status,value) in replies {
                let deadline=std::time::Instant::now()+Duration::from_secs(10);
                let mut stream=loop {
                    match listener.accept() {
                        Ok((stream,_))=>break stream,
                        Err(failure) if failure.kind()==std::io::ErrorKind::WouldBlock&&std::time::Instant::now()<deadline=>std::thread::sleep(Duration::from_millis(5)),
                        Err(failure)=>panic!("未收到预期本机模拟请求：{failure}"),
                    }
                };
                // Windows accepted sockets inherit the listener's nonblocking mode.
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut bytes=Vec::new();
                let mut buffer=[0u8;4096];
                loop {
                    let count=stream.read(&mut buffer).unwrap();assert!(count>0);bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end)=bytes.windows(4).position(|value|value==b"\r\n\r\n") {
                        let header=String::from_utf8_lossy(&bytes[..end]);
                        let length=header.lines().find_map(|line|{let (name,value)=line.split_once(':')?;name.eq_ignore_ascii_case("content-length").then(||value.trim().parse::<usize>().unwrap())}).unwrap_or(0);
                        if bytes.len()>=end+4+length {break;}
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let body=value.to_string();
                write!(stream,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            requests
        });
        (format!("http://{address}"),task)
    }
    #[test]
    fn baidu_table_calls_v2_with_existing_credentials_and_returns_structured_text() {
        let (base,server)=server(vec![(200,json!({"access_token":"synthetic-token"})),(200,response(vec![cell(0,0,"0.00")]))]);
        let value=recognize_at("a+b/==","synthetic-key","synthetic-secret",&base).unwrap();
        assert_eq!(value,json!({"text":"<table><tr><td>0.00</td></tr></table>","engine":"baidu"}));
        let requests=server.join().unwrap();
        assert!(requests[0].starts_with("POST /oauth/2.0/token?"));
        assert!(requests[0].contains("client_id=synthetic-key&client_secret=synthetic-secret"));
        assert!(requests[1].starts_with("POST /rest/2.0/ocr/v1/table?access_token=synthetic-token "));
        assert!(requests[1].contains("image=a%2Bb%2F%3D%3D&return_excel=false"));
        assert!(!requests[1].contains("accurate_basic"));
    }
    #[test]
    fn baidu_table_reports_permission_quota_http_and_malformed_results_without_text_fallback() {
        for (status,value,code,message) in [
            (200,json!({"error_code":6,"error_msg":"No permission"}),"BAIDU_TABLE_REQUEST_FAILED","表格文字识别V2权限"),
            (200,json!({"error_code":17}),"BAIDU_TABLE_REQUEST_FAILED","额度"),
            (403,json!({"error_code":6}),"BAIDU_TABLE_HTTP_ERROR","HTTP 403"),
            (200,json!({"table_num":1,"words_result":[{"words":"只有文字"}]}),"BAIDU_TABLE_INVALID","未返回完整表格"),
        ] {
            let (base,server)=server(vec![(200,json!({"access_token":"synthetic-token"})),(status,value)]);
            let failure=recognize_at("synthetic-image","synthetic-key","synthetic-secret",&base).unwrap_err();
            assert_eq!(failure.code,code);assert!(failure.user_message.contains(message));
            assert_eq!(server.join().unwrap().len(),2);
        }
    }
    #[test]
    fn baidu_table_auth_failure_stops_before_image_and_does_not_expose_credentials() {
        let (base,server)=server(vec![(200,json!({"error":"invalid_client","error_description":"must-not-echo"}))]);
        let failure=recognize_at("synthetic-image","synthetic-key","synthetic-secret",&base).unwrap_err();
        assert_eq!(failure.code,"OCR_TOKEN_FAILED");
        assert!(!format!("{failure:?}").contains("must-not-echo"));
        assert_eq!(server.join().unwrap().len(),1);
        let failure=recognize_at("synthetic-image","sensitive-key","sensitive-secret","http://127.0.0.1:1").unwrap_err();
        let display=format!("{failure:?}");
        assert!(!display.contains("sensitive-key")&&!display.contains("sensitive-secret")&&!display.contains("client_id"));
    }
    #[test]
    fn baidu_table_preserves_merged_cells_empty_cells_and_numeric_strings() {
        let mut value=response(vec![
            json!({"row_start":0,"row_end":2,"col_start":0,"col_end":1,"words":"项目"}),
            cell(0,1,"本期金额"),cell(1,1,"销售额"),cell(2,0,"000123"),cell(2,1,"-12.50"),
            cell(3,0,""),cell(3,1,"*"),cell(4,0,"13%"),cell(4,1,"0.00"),
        ]);
        value["tables_result"][0]["header"]=json!([{"words":"测试税表 & 金额单位：元"}]);
        value["tables_result"][0]["footer"]=json!([{"words":"原页说明\n续行"}]);
        assert_eq!(table_result_html(&value).unwrap(),
            "<p>测试税表 &amp; 金额单位：元</p><table><tr><td rowspan=\"2\">项目</td><td>本期金额</td></tr><tr><td>销售额</td></tr><tr><td>000123</td><td>-12.50</td></tr><tr><td></td><td>*</td></tr><tr><td>13%</td><td>0.00</td></tr></table><p>原页说明<br>续行</p>");
    }
    #[test]
    fn baidu_table_uses_coordinates_instead_of_provider_array_order_and_escapes_text() {
        let value=response(vec![cell(1,1,"1,234.56"),cell(0,1,"<script> & \"内容\""),cell(1,0,"0"),cell(0,0,"列1")]);
        assert_eq!(table_result_html(&value).unwrap(),"<table><tr><td>列1</td><td>&lt;script&gt; &amp; &quot;内容&quot;</td></tr><tr><td>0</td><td>1,234.56</td></tr></table>");
    }
    #[test]
    fn baidu_table_retains_multiple_independent_tables_and_horizontal_spans() {
        let first=response(vec![json!({"row_start":0,"row_end":1,"col_start":0,"col_end":2,"words":"合并标题"}),cell(1,0,"甲"),cell(1,1,"乙")]);
        let second=response(vec![cell(0,0,"单列表")]);
        let value=json!({"table_num":2,"tables_result":[first["tables_result"][0],second["tables_result"][0]]});
        assert_eq!(table_result_html(&value).unwrap(),"<table><tr><td colspan=\"2\">合并标题</td></tr><tr><td>甲</td><td>乙</td></tr></table><table><tr><td>单列表</td></tr></table>");
    }
    #[test]
    fn baidu_table_rejects_missing_overlapping_or_out_of_range_cells() {
        for value in [
            response(vec![cell(0,0,"甲"),cell(1,1,"乙")]),
            response(vec![cell(0,0,"甲"),cell(0,0,"乙")]),
            response(vec![json!({"row_start":0,"row_end":0,"col_start":0,"col_end":1,"words":"甲"})]),
            response(vec![cell(20_000,0,"超范围")]),
            response(vec![cell(0,512,"超范围")]),
            response(vec![json!({"row_start":0,"row_end":1,"col_start":0,"col_end":1})]),
            json!({"table_num":2,"tables_result":[{"body":[cell(0,0,"甲")]}]}),
            json!({"table_num":0,"tables_result":[]}),
        ] {
            assert_eq!(table_result_html(&value).unwrap_err().code,"BAIDU_TABLE_INVALID");
        }
    }
}
