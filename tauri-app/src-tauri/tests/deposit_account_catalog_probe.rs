use audit_toolbox_lib::engine_call_for_test;

#[test]
#[ignore = "依赖本机真实样例，设置 DEPOSIT_TB_SAMPLE 后手工运行"]
fn inspect_real_tb_account_catalog() {
    let path = std::env::var("DEPOSIT_TB_SAMPLE").expect("请设置 DEPOSIT_TB_SAMPLE");
    let inspected = engine_call_for_test(
        "deposit.inspect_tb",
        serde_json::json!({
            "source": {"inputPath": path},
            "mapping": {
                "accountCode": "{NAME}编号",
                "accountName": "{NAME}名称"
            }
        }),
    )
    .expect("存款 TB inspect 应成功");

    println!("headers={:#}", inspected["headers"]);
    println!("mapping={:#}", inspected["suggestedMapping"]);
    for key in ["accounts", "accountsLeaf"] {
        let values = inspected[key].as_array().expect("科目清单应为数组");
        assert!(
            values.len() > 1000,
            "上海君屹样例的科目目录不应再被截断为 1000 条: {key}={}",
            values.len()
        );
        println!("{key}: count={}", values.len());
        println!("  first={:#?}", values.iter().take(12).collect::<Vec<_>>());
        println!(
            "  last={:#?}",
            values.iter().rev().take(12).collect::<Vec<_>>()
        );
    }
}

#[test]
#[ignore = "依赖本机真实样例，设置 DEPOSIT_TB_SAMPLE 后手工运行"]
fn inspect_real_fx_account_catalog() {
    let path = std::env::var("DEPOSIT_TB_SAMPLE").expect("请设置 DEPOSIT_TB_SAMPLE");
    let inspected = engine_call_for_test(
        "fx.inspect_tb",
        serde_json::json!({
            "source": {"inputPath": path},
            "mapping": {
                "accountCode": "{NAME}编号",
                "accountName": "{NAME}名称"
            },
            "fullCatalog": true
        }),
    )
    .expect("汇兑 TB 全量 inspect 应成功");
    let accounts = inspected["accountsLeaf"]
        .as_array()
        .expect("末级科目清单应为数组");
    println!("fx accountsLeaf count={}", accounts.len());
    assert!(
        accounts.len() > 1000,
        "汇兑科目目录不应受旧 200 条截断或大文件采样限制"
    );
    assert_eq!(inspected["sampledPreview"], false);
}
