// 收入合同审阅底稿（V2 示例底稿）主问题映射与填列清单辅助逻辑
(function (global) {
  function q(sheet, row, questionNo, question) {
    return {
      sheet: sheet,
      row: row,
      questionNo: questionNo,
      question: question,
      answerCell: 'D' + row,
      reasonCell: 'E' + row,
      evidenceCell: 'F' + row
    };
  }

  var questions = [
    q('第1步', 5, '1.1', '此协议是否与客户订立，是否适用收入准则？\n\n注意，以下合同不适用HKFRS 15： \n(i) 租赁合同（HKFRS 16/CAS 21）； \n(ii) 保险合同（HKFRS 4或HKFRS 17（如生效）/CAS 25，除非主体选择根据HKFRS 17.8/CAS 25.5对某些服务合同采用HKFRS 15/CAS 14）； \n(iii) 适用HKFRS 9/CAS 22,CAS 23, CAS 24、HKFRS 10/CAS 33、HKFRS 11/CAS 40、HKAS 27和HKAS 28/CAS 2的金融工具及其他合同权利或义务；及\n(iv) 从事相同业务经营的主体之间为便于向客户销售而进行的非货币性交换。\n\n考虑交易对手是否为客户。'),
    q('第1步', 7, '1.1(a)', '合同是否有任何部分被识别为不在HKFRS 15/CAS 14的范围内？'),
    q('第1步', 9, '1.1.1', '此合同是否包含回购条款？'),
    q('第1步', 10, '1.1.1(a)', '是否存在任何回购条款，导致此协议不适用收入准则？'),
    q('第1步', 11, '1.1.1(b)', '如回购条款不适用收入准则，请参见其他相关规定。'),
    q('第1步', 13, '1.2', '此协议是否为与客户签订的符合以下条件的合同？ \n\n- 合同各方已批准该合同并承诺将履行各自义务；\n- 该合同明确了合同各方与所转让商品或提供劳务（以下简称“转让商品”）相关的权利和义务；\n- 该合同有明确的与所转让商品相关的支付条款；\n- 该合同具有商业实质，即履行该合同将改变企业未来现金流量的风险、时间分布或金额；\n- 企业因向客户转让商品而有权取得的对价很可能收回。'),
    q('第1步', 14, '1.2.1', '此协议不符合合同的定义——适用HKFRS 15.14-16/CAS 14.6的规定。'),
    q('第1步', 16, '1.3', '此合同是否与同一客户（或该客户的关联方）的其他合同同时订立或在相近时间内先后订立？'),
    q('第1步', 17, '1.3.1', '合同是否符合下列一个或多个条件？\n\n-这些合同是基于同一商业目的而订立并构成了一揽子交易\n-一项合同的对价金额取决于其他合同的定价或履约情况\n-这些合同所承诺的商品或服务（或每项合同所承诺的部分商品或服务）构成单项履约义务（对于识别单项履约义务的规定，见本文件第2步）'),
    q('第1步', 19, '1.4', '合同自订立或开始起是否进行了变更？\n\n合同变更是经合同各方批准对原合同范围或价格（或两者）作出的变更。对可变对价估计的更新和不影响范围或价格的变更不属于变更。对于可变对价的估计，请参见第3.2步；对于此等估计的变更，请参见第3.6步。'),

    q('第2步', 5, '2.1', '合同中有哪些履约义务？'),
    q('第2步', 10, '2.1.1', '单个采购订单是否代表一系列不同的商品或服务——他们实质上相同且转移模式相同，具有可变对价，需要分配交易价格？'),
    q('第2步', 12, '2.2', '另一方是否参与向客户提供商品或服务？'),
    q('第2步', 13, '2.2.1', '如果另一方参与向客户提供商品或服务，实体应当确定是否需要进行主要责任人与代理人分析。\n\n如果需进行主要责任人与代理人分析，实体是否已确定其在向客户转让每一项特定商品或服务之前其是否控制该商品或服务，因此，实体担任主要责任人还是代理人？\n\n如果实体承诺的性质是实体自行提供特定商品或服务的履约义务，则实体为主要责任人，如果实体承诺安排另一方提供此类商品或服务，则实体为代理人。'),
    q('第2步', 15, '2.3', '任何已承诺服务是否可被视为单独出售的质保，或提供相关产品符合既定标准的保证之外的服务的质保？'),
    q('第2步', 17, '2.4', '合同是否包含任何选择权，向客户提供重大权利，客户可免费或按折扣取得额外商品或服务（例如，销售激励措施、客户奖励积分、续约选择权或针对未来商品或服务的其他折扣），如果不签订合同就无法获得此等权利？'),

    q('第3步', 5, '3.1', '合同中是否仅存在固定的交易价格？\n\n交易价格是指实体因向客户转让已承诺商品或服务而预期有权收取的对价金额，不包括代第三方收取的金额，如销售税'),
    q('第3步', 7, '3.2', '合同中是否存在任何可变或不确定的对价？\n\n可变对价包括折扣、返利、退款、货款抵扣、价格折让、激励措施、业绩奖金、罚款或其他类似情形。 \n\n注意，实体有权收取的对价金额将因未来某一事件的发生或不发生而有所不同时，对价金额是可变的。例如，如果产品销售附带退货权，或承诺在实现特定里程碑时将支付固定金额作为业绩奖金。\n\n对于因授予知识产权许可而承诺的基于销售或使用的特许权使用费收入，请参见HKFRS 15.B63/CASAG 14.VII.(V).4中的可变对价一般规定的例外情况。'),
    q('第3步', 11, '3.3', '合同各方以在合同中明确（或者以隐含的方式）约定的付款时间为客户或企业就转让商品的交易提供了重大融资利益，因而合同包含重大融资成分？\n\n如果付款与履约之间的时间为一年或更短时间，其是否应用简化实务操作，即实体可不考虑重大融资成分的影响。\n\n如果实体正在接受融资，则货币时间价值的影响将导致交易价格上涨。如果实体正在提供融资，则货币时间价值的影响将导致交易价格下降。企业在确定交易价格时，应当对已承诺的对价金额作出调整，以剔除货币时间价值的影响。'),
    q('第3步', 13, '3.4', '实体是否有权获得任何非现金对价？ \n\n实体应将收到的非现金对价的公允价值（在合同开始时计量）计入交易价格。'),
    q('第3步', 15, '3.5', '是否存在任何并非因可明确区分的商品或服务而支付给或应付给客户的对价金额？ \n\n因可明确区分的商品或服务而提供的或超过任何收到的可明确区分的商品或服务的公允价值的对价金额将减去交易价格。'),
    q('第3步', 17, '3.6', '交易价格是否自合同开始起发生了变动？\n\n交易价格的变动包括不确定事项的消除或其他情况变化，导致主体因转让已承诺商品或服务而预期有权获得的对价金额改变。\n\n此等变动将计入交易价格。'),

    q('第4步', 7, '4.1', '合同中是否有任何可变对价归属于合同中的一项或多项（而非全部）履约义务，或归属于构成单项履约义务一部分的一系列可明确区分的商品或服务中，已承诺的一项或多项（而非全部）可明确区分的商品或服务？ \n\n实体可能能够将该可变对价全部分摊至履约义务或构成单项履约义务一部分的可明确区分的商品或服务。'),
    q('第4步', 9, '4.2', '实体是否已确定各项履约义务的单独售价？\n\n应对单独售价进行调整，以消除第4.1步中归属于履约义务的可变对价的影响。 \n\n注意，如果第4.1步中归属的可变对价代表实体因该履约义务预期有权取得的总金额，这可能导致单独售价为0。 \n\n第4.1步中未明确归属的所有可变对价将基于相对独立的售价分摊。'),
    q('第4步', 10, '4.2.1', '记录估计方法和对交易价格分摊的影响。'),
    q('第4步', 12, '4.3', '合同中的折扣是否归属于一项或多项（而非全部）履约义务？\n\n实体可能能够将折扣全部分摊至一项或多项（而非全部）履约义务。'),

    q('第5b步', 5, '5.2', '合同中是否包含与原协议中相同或类似商品相关的回购条款？'),
    q('第5b步', 6, '5.2.1', '合同是否明确卖方有无条件回购资产的义务或权利？（存在远期安排或实体拥有回购选择权）\n\n在回购期权到期未行权之前，控制权不发生转移。'),
    q('第5b步', 8, '5.2.2', '此合同中的客户是否有能力要求实体回购资产？（客户拥有回售选择权）\n\n对于HKFRS 15范围内的回购条款，实体将该交易作为具有退货权的销售（即受限制的可变对价）进行会计处理。\n\n对于作为融资或租赁进行首次会计处理的回购条款，在回购期权到期未行权之前，控制权不转移。'),
    q('第5b步', 11, '5.3', '该合同是否可被视为一项售后代管安排？'),
    q('第5b步', 12, '5.3.1', '除了应用时点要求之外，是否满足以下标准？\n\n-售后代管安排的理由必须具有实质性\n-产品必须单独标识为客户的产品\n-产品当前必须准备好向客户进行实物转移\n-实体无法使用该产品或将其转给其他客户'),
    q('第5b步', 14, '5.4', '该合同是否可被视为一项寄售安排？'),
    q('第5b步', 15, '5.4.1', '商品的控制权是否已转移至经销商或最终用户？'),
    q('第5b步', 17, '5.5', '如果合同中包含客户验收条款，卖方是否客观地确定商品或服务的控制权已根据合同中约定的规格转移给客户？'),
    q('第5b步', 18, '5.5.1', '记录客户验收条款如何影响所有适用履约义务的控制权转移评估。'),

    q('其他', 5, 'C.1', '实体在取得合同时是否产生了预期收回的任何增量成本？ \n\n如果资产的摊销期为一年或一年以下，实体需要确定其是否将进行简化处理，以允许实体将取得合同时产生的增量成本确认为费用。'),
    q('其他', 6, 'C.1.1', '记录实体如何确定合同取得增量成本的资本化金额。'),
    q('其他', 8, 'C.2', '实体是否为履行合同发生了不在其他准则范围内且满足以下标准的成本？\n\n- 该成本与一份当前或预期取得的合同直接相关\n- 该成本产生或增加实体未来用于履行（或继续履行）履约义务的资源\n- 该成本预期能够收回'),
    q('其他', 9, 'C.2.1', '记录实体如何确定合同履约成本的资本化金额。'),
    q('其他', 11, 'C.3', '记录资本化合同成本的摊销方法。实体是否确定了与向客户转让与资本化合同成本相关的商品或服务相一致的系统摊销依据。'),
    q('其他', 13, 'C.4', '资本化合同成本的账面金额是否超出： \n- 实体预期通过与该资产相关的商品或服务交换而获得的剩余对价金额，减去\n- 为提供这些商品和服务直接产生的、尚未确认为费用的成本 '),
    q('其他', 14, 'C.4.1', '合同成本资产已减值。')
  ];

  // Conditional branches are keyed by question number, while result identity remains sheet + row.
  // This keeps the repeated 5.1 questions for each PO independent from the shared decision tree.
  var questionDependencies = [
    { targetQuestionNo: '1.1.1(a)', conditions: [{ questionNo: '1.1.1', operator: 'yes' }] },
    { targetQuestionNo: '1.1.1(b)', conditions: [{ questionNo: '1.1.1(a)', operator: 'yes' }] },
    { targetQuestionNo: '1.2.1', conditions: [{ questionNo: '1.2', operator: 'no' }] },
    { targetQuestionNo: '1.3.1', conditions: [{ questionNo: '1.3', operator: 'yes' }] },
    { targetQuestionNo: '2.2.1', conditions: [{ questionNo: '2.2', operator: 'yes' }] },
    { targetQuestionNo: '3.2', conditions: [{ questionNo: '3.1', operator: 'non_fixed_price' }] },
    { targetQuestionNo: '5.2', conditions: [{ questionNo: '1.1.1', operator: 'yes' }] },
    { targetQuestionNo: '5.2.1', conditions: [{ questionNo: '5.2', operator: 'yes' }] },
    { targetQuestionNo: '5.2.2', conditions: [{ questionNo: '5.2', operator: 'yes' }] },
    { targetQuestionNo: '5.3.1', conditions: [{ questionNo: '5.3', operator: 'yes' }] },
    { targetQuestionNo: '5.4.1', conditions: [{ questionNo: '5.4', operator: 'yes' }] },
    { targetQuestionNo: '5.5.1', conditions: [{ questionNo: '5.5', operator: 'yes' }] },
    { targetQuestionNo: 'C.1.1', conditions: [{ questionNo: 'C.1', operator: 'yes' }] },
    { targetQuestionNo: 'C.2.1', conditions: [{ questionNo: 'C.2', operator: 'yes' }] },
    { targetQuestionNo: 'C.3', match: 'any', conditions: [{ questionNo: 'C.1', operator: 'yes' }, { questionNo: 'C.2', operator: 'yes' }] },
    { targetQuestionNo: 'C.4', match: 'any', conditions: [{ questionNo: 'C.1', operator: 'yes' }, { questionNo: 'C.2', operator: 'yes' }] },
    { targetQuestionNo: 'C.4.1', conditions: [{ questionNo: 'C.4', operator: 'yes' }] }
  ];

  for (var po = 1; po <= 5; po++) {
    var sheet = '第5a步（PO#' + po + '）';
    questions.splice(26 + (po - 1) * 3, 0,
      q(sheet, 5, '5.1', '履约义务是否符合下列任何导致控制权在一段时间内转移的条件？'),
      q(sheet, 10, '5.1.1', '控制权的转移 - 一段时间内'),
      q(sheet, 11, '5.1.2', '控制权的转移 - 时点')
    );
  }

  function norm(value) {
    return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  }

  function findQuestion(item) {
    var sheet = String(item.workpaper_sheet || '').trim();
    var no = String(item.question_no || '').trim();
    var description = norm(item.question_description);
    var bySheetNo = questions.find(function (x) {
      return x.sheet === sheet && String(x.questionNo) === no;
    });
    if (bySheetNo) return bySheetNo;
    if (description) {
      return questions.find(function (x) {
        var target = norm(x.question);
        return target === description || target.indexOf(description) >= 0 || description.indexOf(target) >= 0;
      }) || null;
    }
    return null;
  }

  function confidenceRank(value) {
    var s = String(value || '').toLowerCase();
    if (/高|high/.test(s)) return 3;
    if (/中|medium/.test(s)) return 2;
    if (/低|low/.test(s)) return 1;
    return 0;
  }

  function itemScore(item) {
    var score = confidenceRank(item.confidence) * 20;
    ['suggested_answer', 'contract_basis', 'sop_basis', 'answer_reason', 'contract_excerpt', 'source_documents',
      'supporting_evidence', 'missing_information', 'triggered_sheet', 'appendix_status', 'fill_readiness', 'pages'].forEach(function (key) {
      score += Math.min(String(item[key] || '').trim().length, 500) / 50;
    });
    if (String(item.question_no || '').trim() === '2.1') {
      score += lacksConclusion(item.suggested_answer) ? -30 : 40;
    }
    if (String(item.question_no || '').trim() === '3.2') {
      if (hasSalesPerformanceVariableTerm(item)) score += 100;
      else if (isCustomerLatePaymentPenalty(item)) score -= 40;
    }
    return score;
  }

  function isNoMissingInformation(value) {
    var text = norm(value);
    return !text || text === '无' || text === '不适用' || text === '无需';
  }

  function isProfessionalJudgment(item) {
    var no = String(item.question_no || '').trim();
    return /^(1\.1(?:$|\(a\)|\.1\.[ab])|1\.2|1\.3|2\.1|2\.2\.1|2\.3|2\.4|3\.3|3\.6|4\.|5\.1|5\.2\.[12]|5\.3|5\.4|5\.5|C\.)/.test(no);
  }

  function sopSectionFor(item) {
    var no = String(item.question_no || '').trim();
    if (/^1\./.test(no) || /^5\.2/.test(no)) return 'SOP > 第一步：识别客户合同';
    if (/^2\.1/.test(no)) return 'SOP > 第二步：识别合同中的履约义务 > 识别合同中的履约义务 > 可明确区分的商品';
    if (/^2\.2/.test(no)) return 'SOP > 第二步：识别合同中的履约义务 > 判断主要责任人和代理人';
    if (/^2\.3/.test(no)) return 'SOP > 第二步：识别合同中的履约义务 > 涉及服务类质保';
    if (/^2\.4/.test(no)) return 'SOP > 第二步：识别合同中的履约义务 > 涉及授予重大权利的选择';
    if (no === '3.2') return 'SOP > 第三步：确定交易价格 > 涉及可变对价 > 识别可变对价';
    if (no === '3.3') return 'SOP > 第三步：确定交易价格 > 涉及重大融资成分';
    if (no === '3.4') return 'SOP > 第三步：确定交易价格 > 涉及非现金对价';
    if (no === '3.5') return 'SOP > 第三步：确定交易价格 > 涉及应付客户对价';
    if (/^3\./.test(no)) return 'SOP > 第三步：确定交易价格';
    if (/^4\./.test(no)) return 'SOP > 第四步：将交易价格分摊至单独的履约义务';
    if (/^5\./.test(no)) return 'SOP > 第五步：在实体履约义务时确认收入 > 控制权转移判断';
    if (/^C\./.test(no)) return 'SOP > 其他考虑因素（合同成本）';
    return 'SOP未明确涉及该具体情形';
  }

  function ensureRequiredMissingInformation(item) {
    if (!isNoMissingInformation(item.missing_information)) return;
    var no = String(item.question_no || '').trim();
    if (/^1\.3/.test(no)) item.missing_information = '同期或临近期间与该客户及其关联方订立的其他合同，以及商业目的说明';
    else if (no === '3.3' && !item._sharedPaymentConfirmed) {
      var paymentEvidence = itemText(item);
      var hasPaymentTiming = /\d{1,4}\s*(?:个)?(?:自然日|工作日|日|天|月|年)|付款期限|支付期限|收款期限|履约前付款|履约后付款/.test(paymentEvidence);
      if (lacksConclusion(item.suggested_answer) || !hasPaymentTiming) {
        item.missing_information = '付款时间表与履约时间表（用于比较付款与履约间隔）';
      }
    }
    else if (no === '3.6') item.missing_information = '合同开始日后价格变动、审批记录及最新交易价格测算';
    else if (/^4\./.test(no)) item.missing_information = '各履约义务单独售价依据及交易价格分摊测算';
    else if (/^5\.1/.test(no)) item.missing_information = '履约进度、交付验收及控制权转移的实际执行证据';
    else if (/^C\./.test(no)) item.missing_information = '合同取得/履约成本明细、支持单据及资本化、摊销或减值测算';
  }

  function answerPolarity(value) {
    var text = norm(value).toLowerCase();
    if (/^(是|有|存在|符合|yes|true)/.test(text)) return 'yes';
    if (/^(否|无|不存在|不符合|no|false)/.test(text)) return 'no';
    return '';
  }

  function itemText(item) {
    return [item.suggested_answer, item.contract_basis, item.answer_reason, item.contract_excerpt]
      .map(function (v) { return String(v || ''); }).join(' ');
  }

  function lacksConclusion(value) {
    return /需.*判断|需进一步|无法判断|不能判断|资料不足|信息不足|待判断/.test(String(value || ''));
  }

  function isCustomerLatePaymentPenalty(item) {
    var text = itemText(item);
    return /(客户|买方|甲方).{0,35}(逾期|延期|延迟|未按时|未按约定).{0,25}(付款|支付|结算).{0,80}(违约金|滞纳金|罚息)|((逾期|延期|延迟)付款).{0,80}(违约金|滞纳金|罚息)/.test(text);
  }

  function hasSalesPerformanceVariableTerm(item) {
    var text = itemText(item);
    return /返利|退款|退货权|价格折让|价格保护|销售奖励|业绩奖金|销量奖励|浮动价格|价款扣减|折扣.{0,20}(销售|采购|数量|金额)|(卖方|销售方|供应方|乙方).{0,45}(延迟交付|延期交付|质量不合格|未完成业绩).{0,45}(赔偿|扣款|违约金|减少价款)/.test(text);
  }

  function appendReason(item, text) {
    var current = String(item.answer_reason || '').trim();
    if (current.indexOf(text) < 0) item.answer_reason = current ? current + '；' + text : text;
  }

  function contractEvidenceText(item) {
    return [item.contract_basis, item.contract_excerpt]
      .map(function (value) { return String(value || ''); }).join(' ');
  }

  function startsReasonWith(item, prefix) {
    var reason = String(item.answer_reason || '').trim();
    if (reason.indexOf(prefix) === 0) return;
    item.answer_reason = prefix + (reason ? '，' + reason.replace(/^[，,；;。\s]+/, '') : '。');
  }

  function applyRepurchasePolicy(item) {
    var evidence = contractEvidenceText(item);
    var prefix = '根据我们对收入流程的了解以及对合同条款的检查';
    var hasRepurchase = /回购|购回|买回|重新购买|远期安排|回购选择权|回售选择权|卖方.{0,20}(义务|权利).{0,20}(购买|收回)/.test(evidence);
    var hasQualityReturn = /(质量|瑕疵|缺陷|不合格|质保|保证).{0,45}(退货|换货|退换|更换|修理|维修)|(退货|换货|退换|更换|修理|维修).{0,45}(质量|瑕疵|缺陷|不合格|质保|保证)/.test(evidence);
    var hasGeneralReturn = /退货权|一般退货|无理由退货|退换货|退款退货|客户.{0,20}(退货|退回商品)/.test(evidence);

    if (hasQualityReturn && !hasRepurchase) {
      item.suggested_answer = '否（质量问题退换货不属于回购）';
      item.answer_reason = prefix + '，合同约定的是因质量问题进行退货、换货、修理或更换，属于正常质量保证安排而非回购。';
    } else if (hasGeneralReturn && !hasRepurchase) {
      item.suggested_answer = '否（一般退货权不属于回购）';
      item.answer_reason = prefix + '，合同约定的是客户的一般退货权，未赋予销售方回购资产的义务或权利，因此不属于回购安排。';
    } else {
      startsReasonWith(item, prefix);
    }
  }

  function hasCollectabilityContraryEvidence(item) {
    return /长期逾期|重大逾期|持续逾期|拖欠|拒绝付款|无法支付|无力偿付|资不抵债|破产|信用显著恶化|超出授信|授信不足|历史回款异常|回款困难|重大坏账|高信用风险/.test(itemText(item));
  }

  function criterionDetail(reason, pattern, fallback) {
    var match = String(reason || '').split(/[；。\n]/).filter(function (part) {
      return pattern.test(part);
    })[0];
    return stripContractCriterionHeading(match || fallback);
  }

  function stripContractCriterionHeading(value) {
    var text = String(value || '').trim();
    var heading = '(?:合同批准及履约承诺|各方权利和义务|支付条款|商业实质|对价可收回性)';
    var repeatedHeading = new RegExp('^(?:\\s*[1-5][）).、]?\\s*' + heading + '\\s*[：:]\\s*)+', 'i');
    text = text.replace(repeatedHeading, '').trim();
    // 模型有时会在标准标题后再次输出“1）合同各方已批准”等子标题。
    return text.replace(/^\s*[1-5][）).、]\s*/, '').trim();
  }

  function applyContractExistencePolicy(item) {
    var originalReason = String(item.answer_reason || '').trim();
    var contrary = hasCollectabilityContraryEvidence(item);
    var polarity = answerPolarity(item.suggested_answer);
    if (!contrary && (!polarity || lacksConclusion(item.suggested_answer) || /需结合合同外资料判断/.test(String(item.suggested_answer || '')))) {
      item.suggested_answer = '是（五项合同成立条件均满足）';
      polarity = 'yes';
    } else if (contrary && (lacksConclusion(item.suggested_answer) || !polarity)) {
      item.suggested_answer = '资料不足（存在明确反向证据，需完成对价可收回性评估）';
    }

    var positive = polarity === 'yes';
    var defaultPrefix = positive ? '未见明确反向证据，现有资料支持满足该条件' : '未见明确反向证据，初步支持满足该条件';
    var collectability = contrary
      ? criterionDetail(originalReason, /可收回|信用|授信|回款|逾期|偿付|破产/, '已发现对价可收回性的明确反向证据，需完成专项评估后判断该条件是否满足')
      : '结合合同支付条款、收入流程穿行/控制测试、客户尽调、授信与历史回款，无法收回对价的风险极低';
    var overall = answerPolarity(item.suggested_answer) === 'yes'
      ? '总体结论：五项合同成立条件均满足，建议1.2回答“是”'
      : (answerPolarity(item.suggested_answer) === 'no'
        ? '总体结论：五项条件未全部满足，建议1.2回答“否”'
        : '总体结论：存在明确反向证据，暂标记资料不足并进一步评估');

    item.answer_reason = [
      '1）合同批准及履约承诺：' + criterionDetail(originalReason, /批准|签署|盖章|生效|履约承诺/, defaultPrefix),
      '2）各方权利和义务：' + criterionDetail(originalReason, /权利|义务|商品|服务|交付/, defaultPrefix),
      '3）支付条款：' + criterionDetail(originalReason, /支付条款|付款条款|付款期限|结算/, defaultPrefix),
      '4）商业实质：' + criterionDetail(originalReason, /商业实质|现金流|交易目的/, defaultPrefix),
      '5）对价可收回性：' + collectability,
      overall
    ].join('；') + '。';

    if (!contrary && /^(客户信用评估|客户尽调|信用额度|授信|历史收款|历史回款)/.test(String(item.missing_information || '').trim())) {
      item.missing_information = '无';
    }
  }

  function isSupplementOnlyWithoutMainAgreement(item) {
    var sources = String(item.source_documents || '').split(/[；;,，\n]/).map(function (value) {
      return value.trim();
    }).filter(Boolean);
    var supplementName = /补充协议|变更协议|修订协议|补遗协议/;
    var onlySupplementSources = sources.length > 0 && sources.every(function (source) { return supplementName.test(source); });
    var explicitOnlySupplement = /仅(?:提供|包含|取得).{0,12}(补充协议|变更协议|修订协议|补遗协议)|资料包.{0,12}(只有|仅有|仅含).{0,12}(补充协议|变更协议|修订协议|补遗协议)/.test(itemText(item));
    return onlySupplementSources || explicitOnlySupplement;
  }

  function applyContractCombinationPolicy(item) {
    if (!isSupplementOnlyWithoutMainAgreement(item)) return;
    item.suggested_answer = '资料不足（需取得原合同后联合判断）';
    item.answer_reason = '当前输入仅包含补充协议或变更协议，缺少其所关联的原合同，无法据此回答“否”；应取得原合同并与补充/变更协议联合判断是否需与其他合同合并。';
    item.missing_information = '原合同/主合同（与已提供的补充协议或变更协议联合判断合同合并事项）';
    item.fill_readiness = '资料不足';
    item.confidence = '低';
  }

  function applyPracticalCorrections(item) {
    var no = String(item.question_no || '').trim();
    var text = itemText(item);
    if (no === '1.1.1') applyRepurchasePolicy(item);
    if (no === '1.2') applyContractExistencePolicy(item);
    if (no === '1.3') applyContractCombinationPolicy(item);
    if (no === '2.1' && lacksConclusion(item.suggested_answer)) {
      var separateSignals = 0;
      if (/多种|多个|不同物料|不同商品|不同产品/.test(text)) separateSignals++;
      if (/物料号|物料编号|型号|独立编号|产品编号/.test(text)) separateSignals++;
      if (/单价|分别定价|各自价格|分项价格/.test(text)) separateSignals++;
      if (/分别交付|分批交付|分别验收|独立验收|单独使用/.test(text)) separateSignals++;
      var integrated = /重大整合|重大集成|整体系统|组合产出|重大定制|重大修改|高度关联|不可单独使用|统一验收/.test(text);
      if (integrated) {
        item.suggested_answer = '单项履约义务 - 多个商品和/或服务（初步判断）';
        appendReason(item, '现有条款显示多个组成部分共同形成组合产出或存在整合关系，初步作为单项履约义务；若各组成部分可分别交付、验收和使用，应重新评估');
      } else if (separateSignals >= 2) {
        item.suggested_answer = '多项履约义务（初步判断）';
        appendReason(item, '合同分别列示多种商品及其编号、数量或单价，且未见重大整合、重大定制或高度关联约定，现有证据更支持多项履约义务');
      }
      if (!item.confidence || confidenceRank(item.confidence) < 2) item.confidence = '中';
    }
    if (no === '3.2' && isCustomerLatePaymentPenalty(item) && !hasSalesPerformanceVariableTerm(item)) {
      item.suggested_answer = '否（该条款为客户逾期付款违约责任）';
      item.answer_reason = '该条款约定客户因逾期付款向销售方支付违约金、滞纳金或罚息，属于付款及违约责任，未显示销售方因履约结果减少或调整商品/服务交易对价，因此本条不作为可变对价。';
      item.missing_information = '无';
      item.triggered_sheet = '无';
      item.appendix_status = '未触发';
      item.fill_readiness = '建议填入，需复核';
      item.review_status = '需人工复核';
    }
    item.sop_basis = sopSectionFor(item);
    return item;
  }

  function inferTriggeredSheet(item) {
    var polarity = answerPolarity(item.suggested_answer);
    var no = String(item.question_no || '').trim();
    if (no === '2.2') return '无';
    if (no === '2.2.1') return polarity === 'yes' ? '2.2.1 主要责任人和代理人' : '无';
    if (no === '1.4') return polarity === 'yes' ? '1.4 合同变更' : '无';
    var current = String(item.triggered_sheet || '').trim();
    if (current && current !== '无') return current;
    if (no === '2.1' && /(多项履约义务|单项履约义务.{0,12}多个商品)/.test(String(item.suggested_answer || ''))) return '2.1 履约义务';
    if (polarity !== 'yes' && no !== '5.1.2') return '无';
    if (no === '2.1') return '2.1 履约义务';
    if (no === '2.3') return '2.3 质保';
    if (no === '3.2') return '3.2 可变对价';
    if (no === '3.5') return '3.5 应付客户对价';
    if (/^5\.1(?:\.1|\.2)?$/.test(no)) {
      var poMatch = String(item.workpaper_sheet || '').match(/PO#(\d+)/i);
      var po = poMatch ? poMatch[1] : '1';
      var timing = no === '5.1.2' || (no === '5.1' && polarity === 'no') ? '5.1.2 时点' : '5.1.1 时段';
      return timing + '（PO#' + po + '）';
    }
    return '无';
  }

  function inferAppendixStatus(item) {
    if (!item.triggered_sheet || item.triggered_sheet === '无') return '未触发';
    if (!isNoMissingInformation(item.missing_information)) return '已触发，需补充资料';
    if (isProfessionalJudgment(item) || item.review_status === '需人工复核') return '已触发，需复核';
    return '已触发，可根据合同填列';
  }

  function applySopPolicy(item) {
    item = applyPracticalCorrections(item);
    ensureRequiredMissingInformation(item);
    var professional = isProfessionalJudgment(item);
    var readiness = String(item.fill_readiness || '').trim();
    if (readiness === '需人工判断') readiness = '建议填入，需复核';
    if (readiness === '补充资料后填入') readiness = '资料不足';
    if (!item.suggested_answer || lacksConclusion(item.suggested_answer)) readiness = '资料不足';
    else if (professional && !(item.question_no === '3.3' && item._sharedPaymentConfirmed && isNoMissingInformation(item.missing_information))) readiness = '建议填入，需复核';
    else if (!item.contract_excerpt || confidenceRank(item.confidence) < 3) readiness = '建议填入，需复核';
    else if (['可直接填入', '建议填入，需复核', '资料不足'].indexOf(readiness) < 0) readiness = '可直接填入';
    if (item.question_no === '3.2' && answerPolarity(item.suggested_answer) === 'yes' && hasSalesPerformanceVariableTerm(item) && item.contract_excerpt) {
      readiness = confidenceRank(item.confidence) >= 3 ? '可直接填入' : '建议填入，需复核';
    }
    item.fill_readiness = readiness;
    item.missing_information = String(item.missing_information || '').trim() || '无';
    item.triggered_sheet = inferTriggeredSheet(item);
    item.appendix_status = inferAppendixStatus(item);
    if (readiness !== '可直接填入') item.review_status = '需人工复核';
    if (!item.review_status) item.review_status = '需人工复核';
    return item;
  }

  function dependencyFor(item) {
    var no = typeof item === 'string' ? item : String((item || {}).question_no || '').trim();
    return questionDependencies.find(function (dependency) {
      return dependency.targetQuestionNo === no;
    }) || null;
  }

  function conditionMatches(condition, items, stack) {
    return (items || []).some(function (candidate) {
      if (String(candidate.question_no || '').trim() !== condition.questionNo) return false;
      if (!isVisibleInternal(candidate, items, stack)) return false;
      var polarity = answerPolarity(candidate.suggested_answer);
      if (condition.operator === 'yes') return polarity === 'yes';
      if (condition.operator === 'no') return polarity === 'no';
      if (condition.operator === 'non_fixed_price') {
        return polarity === 'no' || /非固定|可变|浮动|不固定|并非仅.*固定/.test(String(candidate.suggested_answer || ''));
      }
      return false;
    });
  }

  function isVisibleInternal(item, items, stack) {
    var dependency = dependencyFor(item);
    if (!dependency) return true;
    var no = String(item.question_no || '').trim();
    stack = stack || {};
    if (stack[no]) return false;
    var nextStack = Object.assign({}, stack);
    nextStack[no] = true;
    var matches = dependency.conditions.map(function (condition) {
      return conditionMatches(condition, items, nextStack);
    });
    return dependency.match === 'any'
      ? matches.some(Boolean)
      : matches.every(Boolean);
  }

  function isVisible(item, items) {
    if (!item) return false;
    var candidate = typeof item === 'string' ? { question_no: item } : item;
    return isVisibleInternal(candidate, items || [], {});
  }

  function applyConditionalVisibility(items) {
    (items || []).forEach(function (item) {
      var visible = isVisible(item, items);
      item.conditional_hidden = !visible;
      if (!visible) item.applicability = '自动不适用';
      else if (item.applicability === '自动不适用') delete item.applicability;
    });
    return items || [];
  }

  function normalizeResults(items) {
    var dedup = {};
    (items || []).forEach(function (item) {
      var match = findQuestion(item);
      if (match) {
        item.workpaper_match_status = norm(item.question_description) === norm(match.question)
          ? '已定位（工作表、编号、问题描述一致）'
          : '已定位（请核对问题描述）';
        item.workpaper_sheet = match.sheet;
        item.workpaper_row = String(match.row);
        item.question_no = match.questionNo;
        item.question_description = match.question;
      }
      item = applySopPolicy(item);
      var key = match
        ? match.sheet + '|' + match.row
        : [item.workpaper_sheet, item.question_no, norm(item.question_description)].join('|');
      if (!dedup[key] || itemScore(item) > itemScore(dedup[key])) dedup[key] = item;
    });
    var normalized = Object.keys(dedup).map(function (key) { return dedup[key]; }).sort(function (a, b) {
      var ma = findQuestion(a);
      var mb = findQuestion(b);
      var ia = ma ? questions.indexOf(ma) : 9999;
      var ib = mb ? questions.indexOf(mb) : 9999;
      return ia - ib;
    });
    return applyConditionalVisibility(normalized);
  }

  function visibleItems(items) {
    return normalizeResults(items).filter(function (item) { return !item.conditional_hidden; });
  }

  function buildChecklistRows(contract, items) {
    return visibleItems(items).map(function (item, index) {
      var match = findQuestion(item);
      var descriptionMatches = match && norm(item.question_description) === norm(match.question);
      var matchStatus = item.workpaper_match_status || (match
        ? (descriptionMatches ? '已定位（工作表、编号、问题描述一致）' : '已定位（请核对问题描述）')
        : '未定位（请按问题描述人工匹配）');
      var needsReview = !match || /需|是|yes|true/i.test(String(item.review_status || '')) ||
        confidenceRank(item.confidence) < 3 || item.fill_readiness !== '可直接填入';
      return {
        '序号': index + 1,
        '合同名称': contract ? contract.file : '',
        '参考底稿版本': 'V2 U_GP SWP 合同审阅示例底稿',
        '工作表名称': match ? match.sheet : (item.workpaper_sheet || ''),
        '底稿行号': match ? match.row : (item.workpaper_row || ''),
        '问题编号': match ? match.questionNo : (item.question_no || ''),
        '问题描述': match ? match.question : (item.question_description || ''),
        '建议回答': item.suggested_answer || '',
        '合同依据': item.contract_basis || '',
        'SOP定位': item.sop_basis || '',
        '意见 / 回答的理由': item.answer_reason || '',
        '合同条款摘录': item.contract_excerpt || '',
        '来源文件': item.source_documents || '',
        '支持证据描述': item.supporting_evidence || '',
        '附表或判断尚缺资料': item.missing_information || '无',
        '触发附表': item.triggered_sheet || '无',
        '附表完成状态': item.appendix_status || '未触发',
        '主问题填入状态': item.fill_readiness || '资料不足',
        '页码': item.pages || '',
        '置信度': item.confidence || '',
        '复核状态': needsReview ? '需人工复核' : '可复核后采用',
        '回答目标单元格': match ? match.answerCell : '',
        '理由目标单元格': match ? match.reasonCell : '',
        '摘录目标单元格': match ? match.evidenceCell : '',
        '匹配状态': matchStatus
      };
    });
  }

  function uniqueValues(list) {
    var seen = {};
    return (list || []).filter(function (value) {
      value = String(value || '').trim();
      if (!value || seen[value]) return false;
      seen[value] = true;
      return true;
    });
  }

  function stripPaymentMissingClaims(value) {
    return String(value || '').split(/[；。\n]/).filter(function (part) {
      return !(/(付款|支付)条款|付款时间|付款方式/.test(part) && /未明确|未提供|不完整|缺少/.test(part));
    }).join('；').trim();
  }

  function applySharedFacts(items, facts) {
    var normalized = normalizeResults(items);
    var paymentFacts = (facts || []).filter(function (f) {
      return /付款条件|融资相关条件/.test(String(f.fact_type || '')) || /(付款期限|付款时间|支付期限|自然日内付款)/.test(String(f.fact_summary || '') + String(f.contract_excerpt || ''));
    });
    if (!paymentFacts.length) return normalized;
    var paymentText = paymentFacts.map(function (f) { return String(f.fact_summary || '') + ' ' + String(f.contract_excerpt || '') + ' ' + String(f.qualifier || ''); }).join(' ');
    var paymentSummary = uniqueValues(paymentFacts.map(function (f) { return f.fact_summary; })).slice(0, 3).join('；');
    var paymentSources = uniqueValues(paymentFacts.map(function (f) { return f.source_document; })).join('；');
    var paymentPages = uniqueValues(paymentFacts.map(function (f) { return f.pages; })).slice(0, 3).join('、');
    var dayMatch = paymentText.match(/(?:通知|对账|开票|收到[^，。；]{0,12})?[^，。；]{0,20}?(\d{1,3})\s*(?:个)?(?:自然日|工作日|日)(?:内)?/);
    var days = dayMatch ? parseInt(dayMatch[1], 10) : null;
    var refersWorkStatement = /工作说明书|SOW|订单另行约定|另有约定/.test(paymentText);
    var hasWorkStatement = (facts || []).some(function (f) { return /工作说明书|SOW/i.test(String(f.source_document || '')); });

    normalized.forEach(function (item) {
      if (item.question_no === '1.2') {
        item.contract_basis = stripPaymentMissingClaims(item.contract_basis);
        item.answer_reason = stripPaymentMissingClaims(item.answer_reason);
        var confirmed = '资料包已确认付款条件：' + paymentSummary + '。';
        item.contract_basis = item.contract_basis ? item.contract_basis + '；' + confirmed : confirmed;
        item.source_documents = uniqueValues([paymentSources, item.source_documents]).join('；');
        item.pages = uniqueValues([paymentPages, item.pages]).join('、');
      }
      if (item.question_no === '3.3' && days !== null && days <= 365 && !hasWorkStatement) {
        item._sharedPaymentConfirmed = true;
        item.suggested_answer = '否';
        item.contract_basis = paymentSummary;
        item.answer_reason = '资料包显示默认付款期限为' + days + '天，付款与履约间隔预计不超过一年，现有证据不支持存在重大融资成分。' +
          (refersWorkStatement && !hasWorkStatement ? '合同允许工作说明书另行约定，因此当前结论需在取得工作说明书后确认。' : '');
        item.missing_information = refersWorkStatement && !hasWorkStatement
          ? '工作说明书/SOW（核实是否覆盖默认' + days + '天付款期限）'
          : '无';
        item.source_documents = paymentSources;
        item.pages = paymentPages || item.pages;
        item.confidence = refersWorkStatement && !hasWorkStatement ? '中' : '高';
        item.fill_readiness = refersWorkStatement && !hasWorkStatement ? '建议填入，需复核' : '可直接填入';
        item.review_status = refersWorkStatement && !hasWorkStatement ? '需人工复核' : '可复核后采用';
      }
      applySopPolicy(item);
      delete item._sharedPaymentConfirmed;
    });
    return applyConditionalVisibility(normalized);
  }

  function buildMissingTasks(items) {
    var map = {};
    visibleItems(items).forEach(function (item) {
      var text = String(item.missing_information || '').trim();
      if (isNoMissingInformation(text)) return;
      if (!map[text]) map[text] = { text: text, questionNos: [], blocking: false };
      if (map[text].questionNos.indexOf(item.question_no) < 0) map[text].questionNos.push(item.question_no);
      if (item.fill_readiness === '资料不足') map[text].blocking = true;
    });
    return Object.keys(map).map(function (key) { return map[key]; });
  }

  global.REVENUE_WORKPAPER_QUESTIONS = questions;
  global.RevenueWorkpaper = {
    questions: questions,
    questionDependencies: questionDependencies,
    findQuestion: findQuestion,
    normalizeResults: normalizeResults,
    applyConditionalVisibility: applyConditionalVisibility,
    visibleItems: visibleItems,
    isVisible: isVisible,
    buildChecklistRows: buildChecklistRows,
    applySharedFacts: applySharedFacts,
    buildMissingTasks: buildMissingTasks
  };
})(window);
