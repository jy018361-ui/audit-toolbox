// 收入合同审阅底稿（V2 示例底稿）主问题映射与填列清单辅助逻辑
(function (global) {
  function q(sheet, row, questionNo, question, cells) {
    cells = cells || {};
    return {
      sheet: sheet,
      row: row,
      questionNo: questionNo,
      question: question,
      displayQuestionNo: cells.displayQuestionNo || questionNo,
      displayQuestion: cells.displayQuestion || question,
      displaySection: cells.displaySection || '',
      dependencies: cells.dependencies || null,
      answerCell: cells.answerCell || ('D' + row),
      reasonCell: cells.reasonCell || ('E' + row),
      evidenceCell: cells.evidenceCell || ('F' + row),
      detailType: cells.detailType || ''
    };
  }

  var generalInfoQuestions = [
    q('第1部分——一般合同信息', 2, 'GI.1', '客户名称', { answerCell: 'D2' }),
    q('第1部分——一般合同信息', 3, 'GI.2', '法人实体（卖方）', { answerCell: 'D3' }),
    q('第1部分——一般合同信息', 4, 'GI.3', '合同号', { answerCell: 'D4' }),
    q('第1部分——一般合同信息', 5, 'GI.4', '合同计价货币', { answerCell: 'D5' }),
    q('第1部分——一般合同信息', 6, 'GI.5', '合同开始日期', { answerCell: 'D6' })
  ];

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
  // 一般信息只作为首页前置区块，不改变原有五步法问题的插入位置与顺序。
  questions = generalInfoQuestions.concat(questions);

  var stepFiveCriteria = [
    '客户在实体履约的同时即取得并消耗企业履约所带来的经济利益。',
    '实体的履约创造或改良了资产，且客户能够控制履约过程中创造或改良的资产。',
    '履约产出的商品对实体没有替代用途，且实体在整个合同期间有权就累计至今已完成的履约部分收取款项。'
  ];
  var pointInTimeQuestions = [
    { row: 13, no: '5.1.2-1', displayNo: '第2部分(1)', section: '第2部分—评估客户取得控制权的时点', text: '（1）主体就资产享有现时收款权利——HKFRS 15.38(a)或CAS14.13(I)' },
    { row: 16, no: '5.1.2-2', displayNo: '第2部分(2)', section: '第2部分—评估客户取得控制权的时点', text: '（2）客户拥有资产的法定所有权——HKFRS 15.38(b)或CAS14.13(II)' },
    { row: 18, no: '5.1.2-3', displayNo: '第2部分(3)', section: '第2部分—评估客户取得控制权的时点', text: '（3）主体已转移了对资产的实物占有——HKFRS 15.38(c)或CAS14.13(III)' },
    { row: 21, no: '5.1.2-4', displayNo: '第2部分(4)', section: '第2部分—评估客户取得控制权的时点', text: '（4）客户拥有资产所有权上的重大风险和报酬——HKFRS 15.38(d)或CAS14.13(IV)' },
    { row: 24, no: '5.1.2-5', displayNo: '第2部分(5)', section: '第2部分—评估客户取得控制权的时点', text: '（5）客户已接受资产——HKFRS 15.38(e) & B83-B86或CAS14.13(V)' },
    { row: 27, no: '5.1.2-7', displayNo: '第2部分(7)', section: '第2部分—评估客户取得控制权的时点', text: '（7）其他对价（如有，具体说明）' },
    { row: 28, no: '5.1.2-C', displayNo: '第2部分结论', section: '第2部分—评估客户取得控制权的时点', text: '结论（控制权转移至客户的时点）（根据上述内容）' }
  ];
  var overTimeQuestions = [
    { row: 13, no: '5.1.1-A1', displayNo: '第1部分', section: '第1部分—履约情况概述', text: '已承诺商品和服务的性质及实体的履约情况概述' },
    { row: 18, no: '5.1.1-A2', displayNo: '第2部分', section: '第2部分—能否合理计量履约进度', text: '实体是否可合理计量履约进度？' },
    { row: 23, no: '5.1.1-A3', displayNo: '第3部分', section: '第3部分—无法合理计量履约进度', text: '（当实体无法合理计量履约进度时）实体是否预期会收回发生的成本？', dependencies: { conditions: [{ questionNo: '5.1.1-A2', operator: 'no' }] } },
    { row: 29, no: '5.1.1-A4', displayNo: '第4部分', section: '第4部分—选择进度计量方法', text: '（当实体可以合理计量履约进度时）管理层在计量履约进度时采用哪种方法（投入法/产出法）？', dependencies: { conditions: [{ questionNo: '5.1.1-A2', operator: 'yes' }] } },
    { row: 36, no: '5.1.1-O1', displayNo: '第5A部分(a)', section: '第5A部分—产出法', text: '实体是否可使用“有权开具发票”的实务变通计量履约进度？（即，发票金额是否与累计至今实体履约情况“对客户的价值”直接相对应）', dependencies: { conditions: [{ questionNo: '5.1.1-A4', operator: 'contains', value: '产出法' }] } },
    { row: 41, no: '5.1.1-O2', displayNo: '第5A部分(b)', section: '第5A部分—产出法', text: '如果实体不采用/无法采用“有权开具发票”的实务变通计量履约进度，则管理层计量进度的基础是什么？为什么？', dependencies: { conditions: [{ questionNo: '5.1.1-A4', operator: 'contains', value: '产出法' }, { questionNo: '5.1.1-O1', operator: 'no' }] } },
    { row: 48, no: '5.1.1-I1', displayNo: '第5B部分(a)', section: '第5B部分—投入法', text: '管理层计量履约进度的基础是什么？为什么？', dependencies: { conditions: [{ questionNo: '5.1.1-A4', operator: 'contains', value: '投入法' }] } },
    { row: 53, no: '5.1.1-I2', displayNo: '第5B部分(b)', section: '第5B部分—投入法', text: '实体是否发生未包含在合同价款中的明显低效率情况（如，未预期的浪费的材料、人工或其他资源的成本金额）？', dependencies: { conditions: [{ questionNo: '5.1.1-A4', operator: 'contains', value: '投入法' }] } },
    { row: 55, no: '5.1.1-I3', displayNo: '第5B部分(c)', section: '第5B部分—投入法', text: '在客户所在地是否存在任何未安装的材料？', dependencies: { conditions: [{ questionNo: '5.1.1-A4', operator: 'contains', value: '投入法' }] } },
    { row: 61, no: '5.1.1-I3a', displayNo: '第5B部分(c)(i)', section: '第5B部分—未安装材料的四项条件', text: '商品不可明确区分——HKFRS 15.B19(b)(i)/CASAG 14.IV.(III).1.(2)', dependencies: { conditions: [{ questionNo: '5.1.1-I3', operator: 'yes' }] } },
    { row: 64, no: '5.1.1-I3b', displayNo: '第5B部分(c)(ii)', section: '第5B部分—未安装材料的四项条件', text: '客户先取得该商品或材料的控制权，之后才接受与之相关的服务——HKFRS 15.B19(b)(ii)/CASAG 14.IV.(III).1.(2)', dependencies: { conditions: [{ questionNo: '5.1.1-I3', operator: 'yes' }] } },
    { row: 67, no: '5.1.1-I3c', displayNo: '第5B部分(c)(iii)', section: '第5B部分—未安装材料的四项条件', text: '已转移的该商品的成本相对于完全履行履约义务的预计总成本而言是重大的——HKFRS 15.B19(b)(iii)/CASAG 14.IV.(III).1.(2)', dependencies: { conditions: [{ questionNo: '5.1.1-I3', operator: 'yes' }] } },
    { row: 70, no: '5.1.1-I3d', displayNo: '第5B部分(c)(iv)', section: '第5B部分—未安装材料的四项条件', text: '主体自第三方采购了商品，并且未深入参与该商品的设计和制造（但主体作为主要责任人）——HKFRS 15.B19(b)(iv)/CASAG 14.IV.(III).1.(2)', dependencies: { conditions: [{ questionNo: '5.1.1-I3', operator: 'yes' }] } },
    { row: 74, no: '5.1.1-I4', displayNo: '第5B部分—调整', section: '第5B部分—投入法', text: '记录调整详情及理由', dependencies: { groups: [[{ questionNo: '5.1.1-I2', operator: 'yes' }], [{ questionNo: '5.1.1-I3a', operator: 'yes' }, { questionNo: '5.1.1-I3b', operator: 'yes' }, { questionNo: '5.1.1-I3c', operator: 'yes' }, { questionNo: '5.1.1-I3d', operator: 'yes' }]] } },
    { row: 78, no: '5.1.1-I5', displayNo: '第5B部分(d)', section: '第5B部分—投入法', text: '计量履约进度时是否需进行任何其他调整？', dependencies: { conditions: [{ questionNo: '5.1.1-A4', operator: 'contains', value: '投入法' }] } }
  ];
  var overTimeCellLayout = {
    '5.1.1-A1': { row: 14, answerCell: 'B14', reasonCell: 'B14', evidenceCell: 'C14' },
    '5.1.1-A2': { row: 17, answerCell: 'B17', reasonCell: 'B19', evidenceCell: 'C19' },
    '5.1.1-A3': { row: 22, answerCell: 'B22', reasonCell: 'B24', evidenceCell: 'C24' },
    '5.1.1-A4': { row: 28, answerCell: 'B28', reasonCell: 'B30', evidenceCell: 'C30' },
    '5.1.1-O1': { row: 35, answerCell: 'C35', reasonCell: 'B37', evidenceCell: 'C37' },
    '5.1.1-O2': { row: 40, answerCell: 'B40', reasonCell: 'B42', evidenceCell: 'C42' },
    '5.1.1-I1': { row: 47, answerCell: 'B47', reasonCell: 'B49', evidenceCell: 'C49' },
    '5.1.1-I2': { row: 52, answerCell: 'B52', reasonCell: 'B54', evidenceCell: 'C54' },
    '5.1.1-I3': { row: 56, answerCell: 'B56', reasonCell: 'B56', evidenceCell: 'C56' },
    '5.1.1-I3a': { row: 61, answerCell: 'C61', reasonCell: 'B62', evidenceCell: 'C62' },
    '5.1.1-I3b': { row: 64, answerCell: 'C64', reasonCell: 'B65', evidenceCell: 'C65' },
    '5.1.1-I3c': { row: 67, answerCell: 'C67', reasonCell: 'B68', evidenceCell: 'C68' },
    '5.1.1-I3d': { row: 70, answerCell: 'C70', reasonCell: 'B71', evidenceCell: 'C71' },
    '5.1.1-I4': { row: 73, answerCell: 'B73', reasonCell: 'B75', evidenceCell: 'C75' },
    '5.1.1-I5': { row: 77, answerCell: 'B77', reasonCell: 'B79', evidenceCell: 'C79' }
  };
  overTimeQuestions.forEach(function (entry) { Object.assign(entry, overTimeCellLayout[entry.no] || {}); });
  pointInTimeQuestions.forEach(function (entry) {
    if (entry.no === '5.1.2-C') Object.assign(entry, { row: 29, answerCell: 'B29', reasonCell: 'B29', evidenceCell: 'F29' });
  });
  var appendixQuestionTemplates = {
    '1.4 合同变更': [
      { row: 18, no: '1.4-M1', displayNo: '第1部分', section: '第1部分—合同变更简要说明', text: '合同变更（合同范围、价格或二者的变动）的简要说明' },
      { row: 22, no: '1.4-M2', displayNo: '第2部分(a)', section: '第2部分—新增商品或服务', text: '请描述“新增商品或服务”。' },
      { row: 26, no: '1.4-M3', displayNo: '第2部分(b)', section: '第2部分—新增商品或服务', text: '新增商品或服务是否“可明确区分”？（有关可明确区分的确定，见HKFRS 15第27-29段或CASAG 14、四、(二)、1）' },
      { row: 30, no: '1.4-M4', displayNo: '第2部分(c)', section: '第2部分—新增商品或服务', text: '新增合同价款是否反映新增商品或服务的“单独售价”？（单独售价指引见HKFRS 15第77-78段或CASAG 14、五、(二)、1）' },
      { row: 33, no: '1.4-M5', displayNo: '第2部分结论', section: '第2部分—新增商品或服务', text: '考虑(b)“可明确区分”且(c)“具有单独售价”的(a)“新增商品或服务”之后，合同变更是否应作为单独合同进行会计处理？' },
      { row: 37, no: '1.4-M6', displayNo: '第3部分(a)', section: '第3部分—不作为单独合同的会计处理', text: '“剩余商品或服务”是什么？', dependencies: { conditions: [{ questionNo: '1.4-M5', operator: 'no' }] } },
      { row: 39, no: '1.4-M7', displayNo: '第3部分(b)', section: '第3部分—不作为单独合同的会计处理', text: '剩余商品或服务与已经提供的商品或服务是否“可明确区分”？', dependencies: { conditions: [{ questionNo: '1.4-M5', operator: 'no' }] } },
      { row: 42, no: '1.4-M8', displayNo: '第3部分结论', section: '第3部分—不作为单独合同的会计处理', text: '考虑(a)“剩余商品或服务”以及其与已经提供的商品或服务是否(b)“可明确区分”之后，合同变更应作为原合同终止并订立新合同，还是作为原合同组成部分进行累计追溯调整？', dependencies: { conditions: [{ questionNo: '1.4-M5', operator: 'no' }] } }
    ],
    '2.2.1 PVA': [
      { row: 16, no: '2.2.1-PVA1', displayNo: '第1部分', section: '第1部分—安排和承诺性质', text: '安排和承诺性质的简要说明（即，主体提供特定商品或服务或安排提供特定商品或服务）' },
      { row: 20, no: '2.2.1-PVA2', displayNo: '第2部分', section: '第2部分—特定商品或服务', text: '待提供的特定商品或服务（标的商品或服务或获取标的商品或服务的权利）' },
      { row: 23, no: '2.2.1-PVA3', displayNo: '第3部分', section: '第3部分—参与的第三方', text: '参与提供特定商品或服务的第三方是谁？第三方参与的性质是什么？' },
      { row: 27, no: '2.2.1-PVA4', displayNo: '第4部分', section: '第4部分—识别客户', text: '客户是谁？客户可能是供应商、用户或二者，具体取决于承诺的性质？' },
      { row: 33, no: '2.2.1-PVA5', displayNo: '第5部分', section: '第5部分—转让前的控制', text: '主体是否在向客户转让特定商品或服务之前“控制”该商品或服务？' },
      { row: 41, no: '2.2.1-PVA6', displayNo: '第6部分(1)', section: '第6部分—主要指标', text: '主要指标#1：主体承担向客户转让商品的主要责任' },
      { row: 45, no: '2.2.1-PVA7', displayNo: '第6部分(2)', section: '第6部分—主要指标', text: '主要指标#2：主体在转让商品或服务之前或之后承担了存货风险' },
      { row: 49, no: '2.2.1-PVA8', displayNo: '第6部分(3)', section: '第6部分—主要指标', text: '主要指标#3：主体拥有自主定价权' },
      { row: 52, no: '2.2.1-PVA9', displayNo: '第7部分', section: '第7部分—结论', text: '结论（考虑控制原则（如适用，主要指标）之后，主体为安排中的主要责任人/代理人）' },
      { row: 55, no: '2.2.1-PVA10', displayNo: '第8部分', section: '第8部分—其他履约义务', text: '是否有任何其他履约义务需要进一步评估主要责任人与代理人的关系？' }
    ],
    '2.3 质保': [
      { row: 15, no: '2.3-W1', displayNo: '第1部分', section: '第1部分—质保安排', text: '简要描述与客户的质保安排' },
      { row: 18, no: '2.3-W2', displayNo: '第2部分', section: '第2部分—能否单独购买', text: '根据上述描述，客户是否可以选择单独购买质保？' },
      { row: 26, no: '2.3-W4', displayNo: '第3部分(a)', section: '第3部分—是否提供额外服务', text: '法律是否要求质保？', dependencies: { conditions: [{ questionNo: '2.3-W2', operator: 'no' }] } },
      { row: 30, no: '2.3-W5', displayNo: '第3部分(b)', section: '第3部分—是否提供额外服务', text: '质保期长度', dependencies: { conditions: [{ questionNo: '2.3-W2', operator: 'no' }] } },
      { row: 34, no: '2.3-W6', displayNo: '第3部分(c)', section: '第3部分—是否提供额外服务', text: '实体承诺履行任务的性质', dependencies: { conditions: [{ questionNo: '2.3-W2', operator: 'no' }] } },
      { row: 38, no: '2.3-W7', displayNo: '第3部分(d)', section: '第3部分—是否提供额外服务', text: '法律是否要求对造成伤害或损害的产品进行赔偿？', dependencies: { conditions: [{ questionNo: '2.3-W2', operator: 'no' }] } },
      { row: 41, no: '2.3-W8', displayNo: '第3部分(e)', section: '第3部分—是否提供额外服务', text: '质保是否承诺赔偿客户因专利、版权、商标或实体产品的其他侵权索赔而产生的责任和损害？', dependencies: { conditions: [{ questionNo: '2.3-W2', operator: 'no' }] } },
      { row: 44, no: '2.3-W9', displayNo: '第3部分结论', section: '第3部分—是否提供额外服务', text: '除了保证产品符合既定标准外，质保是否还向客户提供服务？（考虑上述因素后）', reasonCell: 'B46', evidenceCell: 'C46', dependencies: { conditions: [{ questionNo: '2.3-W2', operator: 'no' }] } },
      { row: 49, no: '2.3-W10', displayNo: '第4部分', section: '第4部分—质保类型组合', text: '合同是否包括保证型质保和服务型质保？' },
      { row: 52, no: '2.3-W11', displayNo: '第5部分', section: '第5部分—质保分配', text: '保证型质保和服务型质保能否合理分配？', dependencies: { conditions: [{ questionNo: '2.3-W10', operator: 'yes' }] } },
      { row: 55, no: '2.3-W12', displayNo: '第5部分—分配基础', section: '第5部分—质保分配', text: '保证型和服务型质保之间的分配基础。', dependencies: { conditions: [{ questionNo: '2.3-W10', operator: 'yes' }, { questionNo: '2.3-W11', operator: 'yes' }] } }
    ],
    '3.2 可变对价': [
      { row: 18, no: '3.2-VC1', displayNo: '第1部分', section: '第1部分—识别可变对价', text: '简要描述合同条款和导致对价变化的事件' },
      { row: 22, no: '3.2-VC2', displayNo: '第2部分(1)', section: '第2部分—可变对价的估计', text: '实体有权获得的可变对价的可能结果是什么？仅有两个可能结果，还是存在多个可能结果？每种结果的概率是多少？' },
      { row: 26, no: '3.2-VC3', displayNo: '第2部分(2)', section: '第2部分—可变对价的估计', text: '实体用于估计可变对价的方法及其选择依据是什么？', reasonCell: 'B28', evidenceCell: 'C28' },
      { row: 30, no: '3.2-VC4', displayNo: '第2部分—估计计算', section: '第2部分—可变对价的估计', text: '估计可变对价——计算期望值（如使用期望值）或最可能发生的单一金额（如使用最可能发生金额）。' },
      { row: 40, no: '3.2-VC5', displayNo: '第3部分(a)(i)', section: '第3部分—应用可变对价限制', text: '对价金额极易受到超出主体影响范围之外的因素影响（例如，市场波动性、第三方的判断或行动、天气状况、已承诺商品或服务存在较高的陈旧过时风险）——HKFRS15.57(a)或CASAG 14.V.(I).1(2)', answerCell: 'C40', reasonCell: 'B41', evidenceCell: 'C41' },
      { row: 43, no: '3.2-VC6', displayNo: '第3部分(a)(ii)', section: '第3部分—应用可变对价限制', text: '关于对价金额的不确定性预计在较长时期内均无法消除。——HKFRS 15.57(b)或CASAG 14.V.(I).1(2)', answerCell: 'C43', reasonCell: 'B44', evidenceCell: 'C44' },
      { row: 46, no: '3.2-VC7', displayNo: '第3部分(a)(iii)', section: '第3部分—应用可变对价限制', text: '主体对类似类型合同的经验（或其他证据）有限，或相关经验（或其他证据）的预测价值有限。——HKFRS 15.57(c)或CASAG 14.V.(I).1(2)', answerCell: 'C46', reasonCell: 'B47', evidenceCell: 'C47' },
      { row: 49, no: '3.2-VC8', displayNo: '第3部分(a)(iv)', section: '第3部分—应用可变对价限制', text: '主体在实务中对相似情形下的类似合同提供了较多不同程度的价格折让或不同的付款条款和条件。——HKFRS 15.57(d)或CASAG 14.V.(I).1(2)', answerCell: 'C49', reasonCell: 'B50', evidenceCell: 'C50' },
      { row: 52, no: '3.2-VC9', displayNo: '第3部分(a)(v)', section: '第3部分—应用可变对价限制', text: '合同具有大量且分布广泛的可能发生的对价金额。——HKFRS 15.57(e)或CASAG 14.V.(I).1(2)', answerCell: 'C52', reasonCell: 'B53', evidenceCell: 'C53' },
      { row: 55, no: '3.2-VC10', displayNo: '第3部分(a)(vi)', section: '第3部分—应用可变对价限制', text: '其他考虑因素（如有，请指明）', answerCell: 'C55', reasonCell: 'B56', evidenceCell: 'C56' },
      { row: 60, no: '3.2-VC11', displayNo: '第3部分(b)', section: '第3部分—应用可变对价限制', text: '评估潜在转回对在合同层面确认的累计收入的“重大性”', answerCell: 'C60', reasonCell: 'B60', evidenceCell: 'C60' },
      { row: 62, no: '3.2-VC12', displayNo: '第3部分结论', section: '第3部分—应用可变对价限制', text: '已确认的累计收入金额是否“极可能”不会发生“重大”转回？是否需要对全部或部分可变对价进行限制？' },
      { row: 64, no: '3.2-VC13', displayNo: '第3部分—限制依据', section: '第3部分—应用可变对价限制', text: '关于是否需要对全部或部分可变对价进行限制的依据。如需要进行限制，则说明定量和确定依据。' },
      { row: 67, no: '3.2-VC14', displayNo: '第4部分', section: '第4部分—其他履约义务', text: '是否需要进一步可变对价评估的任何其他履约义务？' }
    ],
    '3.5 客户对价': [
      { row: 17, no: '3.5-PC1', displayNo: '第1部分', section: '第1部分—应付客户对价简述', text: '简要描述（1）提供给客户的商品和服务以及（2）应付客户对价的性质。' },
      { row: 21, no: '3.5-PC2', displayNo: '第2部分', section: '第2部分—是否取得可明确区分的商品或服务', text: '评估应付客户对价是否用于从客户获取“可明确区分的”商品或服务？请提供理由。' },
      { row: 23, no: '3.5-PC3', displayNo: '第2部分结论', section: '第2部分—是否取得可明确区分的商品或服务', text: '应付客户对价是否用于获取可明确区分的商品或服务？' },
      { row: 26, no: '3.5-PC4', displayNo: '第3部分', section: '第3部分—定价与公允价值', text: '可明确区分的商品或服务是如何定价的？能否合理估计可明确区分的商品或服务的公允价值？如果能，估计可明确区分的商品或服务的公允价值的基础。', dependencies: { conditions: [{ questionNo: '3.5-PC3', operator: 'yes' }] } },
      { row: 28, no: '3.5-PC5', displayNo: '第3部分结论', section: '第3部分—定价与公允价值', text: '可明确区分的商品或服务的公允价值能否合理估计？', dependencies: { conditions: [{ questionNo: '3.5-PC3', operator: 'yes' }] } },
      { row: 31, no: '3.5-PC6', displayNo: '第4部分', section: '第4部分—超过公允价值的金额', text: '应付客户对价的金额是否超过可明确区分的商品或服务的公允价值？', dependencies: { conditions: [{ questionNo: '3.5-PC5', operator: 'yes' }] } }
    ]
  };
  var detailQuestions = [];
  for (var detailPo = 1; detailPo <= 5; detailPo++) {
    var stepSheet = '第5a步（PO#' + detailPo + '）';
    stepFiveCriteria.forEach(function (text, index) {
      detailQuestions.push(q(stepSheet, 6 + index, '5.1-C' + (index + 1), text, {
        displayQuestionNo: '时段条件' + (index + 1),
        displayQuestion: text,
        displaySection: '第5.1步—控制权在一段时间内转移的条件',
        detailType: 'step_five_criterion'
      }));
    });
    pointInTimeQuestions.forEach(function (entry) {
      detailQuestions.push(q('5.1.2 时点（PO#' + detailPo + '）', entry.row, entry.no, entry.text, {
        displayQuestionNo: entry.displayNo,
        displayQuestion: entry.text,
        displaySection: entry.section,
        dependencies: entry.dependencies,
        answerCell: entry.answerCell,
        reasonCell: entry.reasonCell,
        evidenceCell: entry.evidenceCell,
        detailType: 'point_in_time'
      }));
    });
    overTimeQuestions.forEach(function (entry) {
      detailQuestions.push(q('5.1.1 时段（PO#' + detailPo + '）', entry.row, entry.no, entry.text, {
        answerCell: entry.answerCell || ('B' + entry.row),
        reasonCell: entry.reasonCell || ('B' + entry.row),
        evidenceCell: entry.evidenceCell || ('C' + entry.row),
        displayQuestionNo: entry.displayNo,
        displayQuestion: entry.text,
        displaySection: entry.section,
        dependencies: entry.dependencies,
        detailType: 'over_time'
      }));
    });
  }
  Object.keys(appendixQuestionTemplates).forEach(function (sheet) {
    appendixQuestionTemplates[sheet].forEach(function (entry) {
      detailQuestions.push(q(sheet, entry.row, entry.no, entry.text, {
        answerCell: entry.answerCell || ('B' + entry.row),
        reasonCell: entry.reasonCell || ('B' + entry.row),
        evidenceCell: entry.evidenceCell || ('C' + entry.row),
        displayQuestionNo: entry.displayNo,
        displayQuestion: entry.text,
        displaySection: entry.section,
        dependencies: entry.dependencies,
        detailType: 'triggered_appendix'
      }));
    });
  });
  var allQuestions = questions.concat(detailQuestions);

  function norm(value) {
    return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  }

  function findQuestion(item) {
    var sheet = String(item.workpaper_sheet || '').trim();
    var no = String(item.question_no || '').trim();
    var description = norm(item.question_description);
    var obligationMatch = no.match(/^2\.1-PO#(\d+)$/i);
    if (sheet === '2.1 履约义务' && obligationMatch) {
      var obligationRow = 5 + parseInt(obligationMatch[1], 10);
      return q(sheet, obligationRow, no, item.question_description || ('履约义务 ' + obligationMatch[1]), {
        answerCell: 'H' + obligationRow,
        reasonCell: 'I' + obligationRow,
        evidenceCell: 'C' + obligationRow,
        displayQuestionNo: '第' + obligationMatch[1] + '项履约义务',
        displayQuestion: item.question_description || ('商品和/或服务 ' + obligationMatch[1]),
        displaySection: '履约义务清单',
        detailType: 'performance_obligation'
      });
    }
    var bySheetNo = allQuestions.find(function (x) {
      return x.sheet === sheet && String(x.questionNo) === no;
    });
    if (bySheetNo) return bySheetNo;
    var normalizedTemplate = normalizeTemplateSheet(sheet);
    if (normalizedTemplate) {
      var byTemplateNo = allQuestions.find(function (x) {
        return normalizeTemplateSheet(x.sheet) === normalizedTemplate && String(x.questionNo) === no;
      });
      if (byTemplateNo) return Object.assign({}, byTemplateNo, { sheet: sheet });
    }
    // Main-workpaper question numbers are unique. Models occasionally return a
    // descriptive sheet title (for example “第一步：识别客户合同”) instead of the
    // exact template tab name. Resolve those items by their unique number before
    // declaring the whole answer batch missing. Repeated PO/detail numbers still
    // require their sheet/PO context and therefore are not matched here.
    if (no) {
      var byNo = allQuestions.filter(function (x) { return String(x.questionNo) === no; });
      if (byNo.length === 1) return byNo[0];
    }
    if (description) {
      return allQuestions.find(function (x) {
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
      'supporting_evidence', 'missing_information', 'triggered_sheet', 'appendix_status', 'fill_readiness', 'pages',
      'performance_obligations', 'appendix_subjects', 'appendix_plan', 'over_time_criteria'].forEach(function (key) {
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
    if (/^GI\./.test(no)) return 'SOP > 第一步：识别客户合同';
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

  var YES_NO_OPTIONS = ['是', '否'];
  var TEMPLATE_ANSWER_OPTIONS = {
    '1.1(a)': YES_NO_OPTIONS, '1.1.1': YES_NO_OPTIONS, '1.1.1(a)': YES_NO_OPTIONS,
    '1.2': YES_NO_OPTIONS, '1.3': YES_NO_OPTIONS,
    '1.3.1': ['是——将合同合并，在后续的五步分析中将其一并考虑', '否——分别评估各合同'],
    '1.4': ['是——请参见“1.4 合同变更”标签页，获取详细信息', '否'],
    '2.1': ['单项履约义务——单项商品或服务', '单项履约义务——多项商品和/或服务——请参见“2.1 履约义务”标签页，获取详细信息', '多项履约义务——请参见“2.1 履约义务”标签页，获取详细信息'],
    '2.1.1': ['是-请参阅“第4步”工作表了解更多详细信息', '否'],
    '2.2': YES_NO_OPTIONS,
    '2.2.1': ['是——请参见“2.2.1 PVA”标签页，获取详细信息', '否'],
    '2.3': ['是——请参见“2.3 质保”标签页，获取详细信息', '否'],
    '2.4': YES_NO_OPTIONS,
    '3.1': ['是（固定价格）', '否（可变对价）—继续第3.2步', '否（固定价格和可变对价均存在）—继续第3.2步'],
    '3.2': ['是—请参见“3.2 可变对价”工作表，了解更多详情', '是-实体不估计可变对价，因为金额在报告期末已知', '否'],
    '3.3': YES_NO_OPTIONS, '3.4': YES_NO_OPTIONS,
    '3.5': ['是—请参见“3.5 应付客户对价”工作表，了解更多详情', '否'],
    '3.6': YES_NO_OPTIONS, '4.1': YES_NO_OPTIONS, '4.2': YES_NO_OPTIONS, '4.3': YES_NO_OPTIONS,
    '5.2': YES_NO_OPTIONS, '5.2.1': YES_NO_OPTIONS, '5.2.2': YES_NO_OPTIONS,
    '5.3': YES_NO_OPTIONS, '5.4': YES_NO_OPTIONS, '5.5': YES_NO_OPTIONS,
    'C.1': YES_NO_OPTIONS, 'C.2': YES_NO_OPTIONS, 'C.4': YES_NO_OPTIONS,
    '1.4-M5': [
      '基于上述情况，合同变更涉及“可明确区分”且具有“单独售价”的“新增商品或服务”的提供。合同作为单独合同进行会计处理（结果1）。',
      '基于上述情况，合同变更不涉及“可明确区分”且具有“单独售价”的“新增商品或服务”的提供。请转到第3部分进行进一步评估。'
    ],
    '1.4-M8': [
      '基于上述情况，剩余商品或服务与已经提供的商品或服务可明确区分，且合同变更根据前瞻法进行会计处理（即，终止现有合同并创建新合同）（结果2）。',
      '基于上述情况，剩余商品或服务与已经提供的商品或服务没有区别，且合同变更作为现有合同的一部分进行会计处理，且构成单项履约义务的一部分，且收入按累计增加法进行调整（结果3）。',
      '基于上述情况，部分剩余商品或服务与已经提供的商品或服务可明确区分，而部分剩余商品或服务与已经提供的商品或服务不可明确区分。因此，(i)不对可与已修订商品或服务明确区分的完全履约义务进行调整且(ii)对与合同已修订部分不可明确区分的履约义务进行累计增加调整（结果4）。'
    ],
    '2.2.1-PVA9': ['基于上述评估，主体是安排中的主要责任人。', '基于上述评估，主体是安排中的代理人。'],
    '2.2.1-PVA10': YES_NO_OPTIONS,
    '2.3-W2': [
      '是—客户可以选择单独购买质保。这是服务型质保，作为单独的履约义务进行会计处理。',
      '否—客户不可以选择单独购买质保。请转到第3部分进行进一步评估。',
      '合同包括质保，其中一部分是客户可选择购买的。就顾客可以选择单独购买的质保而言，它属于服务型质保。关于不能单独购买的质保，请转到第3部分进行进一步评估.'
    ],
    '2.3-W9': [
      '是—质保(或部分质保)除保证产品符合商定的规格外，还向客户提供服务。这是服务型质保，作为单独的履约义务进行会计处理。',
      '否—质保(或部分质保)除保证产品符合商定的规格外，不向客户提供服务。质保(或部分质保)属于担保型质保，并根据HKAS 37进行会计处理。',
      '是和否——与客户签订的合同包括担保型和服务型质保。请转到第4部分进行进一步评估。'
    ],
    '2.3-W10': ['是—合同同时包括保证型质保和服务型质保。请转到第5部分进行进一步评估。', '否—合同不同时包括保证型质保和服务型质保。'],
    '2.3-W11': ['是—保证型质保和服务型质保能够合理分配。请在下面记录分配依据。', '否—保证型质保和服务型质保不能合理分配。质保被视为一项单独的履约义务，并在质保服务提供期间予以确认。'],
    '3.2-VC3': ['期望值', '最可能发生金额'],
    '3.2-VC12': [
      '已确认的累计收入金额极可能会发生重大转回，且可变对价的估计会减少，直到达到可纳入交易价格的金额，如果后续在与可变对价相关的不确定性后续消除时被转回，将不会导致已确认累计收入的重大转回。',
      '已确认的累计收入金额极可能不会发生重大转回，因此无需对可变对价进行限制。'
    ],
    '3.5-PC3': ['是—应付客户对价是用于获取可明确区分的商品或服务，请转到第3部分进行进一步评估。', '否—应付客户对价不是用于获取可明确区分的商品或服务，因此其应作为交易价格的抵减进行会计处理（结果1）。'],
    '3.5-PC5': ['是—可以可靠估计可明确区分的商品或服务的公允价值，请转到第4部分进行进一步评估。', '否—不能可靠估计可明确区分的商品或服务的公允价值，因此其应作为交易价格的抵减进行会计处理（结果1）。'],
    '3.5-PC6': ['是—应付客户对价的金额超过可明确区分的商品或服务的公允价值。对于支付从客户处收到的可明确区分的商品或服务的公允价值的对价，采用与主体向供应商进行的其他采购相同的方式对应付客户对价进行会计处理。超出部分将作为交易价格的抵减进行会计处理。（结果2）', '否—应付客户对价的金额没有超过可明确区分的商品或服务的公允价值，因此采用与主体向供应商进行的其他采购相同的方式对对价进行会计处理。（结果3）'],
    '5.1.1-A2': ['是 - 主体可合理计量履约进度。请继续第4部分。', '否 - 主体无法合理计量履约进度。请在下面载明导致主体无法计量履约进度的情况，并继续第3部分。'],
    '5.1.1-A3': ['是 - 预计发生的成本可收回，且仅以发生成本为限可确认收入。', '否 - 预计发生的成本不可收回，且在履约进度可合理计量之前，收入不可确认。'],
    '5.1.1-A4': ['用产出法计量进度。请在下面填写第5A部分“产出法”。', '用投入法计量进度。请在下面填写第5B部分“投入法”。'],
    '5.1.1-O1': ['是 - 发票金额与累计至今主体已完成的履约义务对于客户的价值直接相对应。采用“有权开具发票”的实务变通来计量履约进度。', '是 - 发票金额与累计至今主体已完成的履约义务对于客户的价值直接相对应。但是，未采用“有权开具发票”的实务变通计量履约进度。', '否 - 发票金额与累计至今主体已完成的履约义务对于客户的价值不直接相对应。无法采用“有权开具发票”的实务变通计量履约进度。'],
    '5.1.1-O2': ['测量累计至今的完工进度', '评估已实现的结果', '已达到的里程碑', '时间进度', '已完成或交付的商品或服务单位', '其他 - 请具体说明依据'],
    '5.1.1-I1': ['耗费的材料数量', '花费的工时数', '发生的成本', '时间进度', '使用的机器工时', '其他 - 请具体说明依据'],
    '5.1.1-I2': ['是 - 主体发生未包括在合同价款中的明显低效率情况。因此，需在计量进度时对低效率情况进行调整 - 请具体说明', '否 - 主体未发生未包括在合同价款中的明显低效率情况，因此，无需在计量进度时进行调整'],
    '5.1.1-I3': ['是 - 客户所在地存在未安装的材料。', '否 - 客户所在地无未安装的材料。'],
    '5.1.1-I4': ['是 - 满足所有四个条件，且需在计量履约进度时进行调整。未安装的材料仅以发生的成本为限确认 - 请具体说明调整情况。', '否 - 无/未满足所有四个条件，无需进行调整。'],
    '5.1.1-I5': ['是 - 计量进度时需进行其他调整 - 请具体说明', '否 - 计量进度时无需进行其他调整']
  };
  ['3.2-VC5', '3.2-VC6', '3.2-VC7', '3.2-VC8', '3.2-VC9', '3.2-VC10', '3.2-VC14',
    '5.1-C1', '5.1-C2', '5.1-C3', '5.1.1-I3a', '5.1.1-I3b', '5.1.1-I3c', '5.1.1-I3d',
    '5.1.2-1', '5.1.2-2', '5.1.2-3', '5.1.2-4', '5.1.2-5', '5.1.2-7'].forEach(function (no) {
    TEMPLATE_ANSWER_OPTIONS[no] = YES_NO_OPTIONS;
  });

  function normalizeTemplateSuggestedAnswer(item) {
    var no = String(item.question_no || '').trim();
    var raw = String(item.suggested_answer || '').trim();
    // 技术提取失败不等同于业务判断；占位行保持底稿答案为空，由复核状态承接。
    if (item.technical_fallback || item.answer_mapping_blocked) {
      item.suggested_answer = '';
      return item;
    }
    var options = TEMPLATE_ANSWER_OPTIONS[no];
    if (!options) {
      if (lacksConclusion(raw) || /需要人工判断|需人工复核/.test(raw)) markTemplateAnswerUnresolved(item, raw);
      return item;
    }
    var exact = options.find(function (option) { return norm(option) === norm(raw); });
    if (exact) {
      item.suggested_answer = exact;
      return item;
    }
    var evidence = [raw, item.answer_reason, item.contract_basis, item.contract_excerpt].join(' ');
    var mapped = mapTemplateAnswer(no, raw, evidence, options);
    if (mapped) item.suggested_answer = mapped;
    else markTemplateAnswerUnresolved(item, raw);
    return item;
  }

  function markTemplateAnswerUnresolved(item, raw) {
    item.suggested_answer = '';
    item.answer_mapping_blocked = true;
    appendReason(item, '原建议值“' + (raw || '空白') + '”无法可靠映射到底稿固定选项，系统未代替项目组猜测填值');
    item.confidence = '低';
    item.review_status = '需人工复核';
    if (isNoMissingInformation(item.missing_information)) item.missing_information = '需复核并选择底稿允许的固定选项';
  }

  function inferredPolarity(raw, evidence) {
    var polarity = answerPolarity(raw);
    if (polarity) return polarity;
    if (/不构成|不存在|未发现|不满足|不能|不可|无需|不包括|未包括|没有/.test(evidence)) return 'no';
    if (/构成|存在|满足|能够|可以|包括|适用/.test(evidence)) return 'yes';
    return '';
  }

  function templateAnswerPolarity(questionNo, value) {
    var no = String(questionNo || '').trim();
    var options = TEMPLATE_ANSWER_OPTIONS[no] || [];
    var matchedIndex = options.findIndex(function (option) { return norm(option) === norm(value); });
    if (no === '1.4-M5' && matchedIndex >= 0) return matchedIndex === 0 ? 'yes' : 'no';
    // 第三个选项仍要求对不能单独购买的部分进入第3部分。
    if (no === '2.3-W2' && matchedIndex === 2) return 'no';
    return answerPolarity(value);
  }

  function mapTemplateAnswer(no, raw, evidence, options) {
    if (no === '2.1') {
      if (/单项履约义务.{0,8}(?:单个|单项)商品/.test(raw)) return options[0];
      if (/单项履约义务.{0,12}(?:多个|多项)商品/.test(raw)) return options[1];
      if (/多项履约义务/.test(raw)) return options[2];
    }
    if (no === '3.1') {
      var pricePolarity = inferredPolarity(raw, evidence);
      if (pricePolarity === 'yes') return options[0];
      if (/固定价格.{0,12}(?:和|及|与).{0,12}可变对价|固定.{0,8}可变.{0,8}均存在/.test(evidence)) return options[2];
      if (pricePolarity === 'no' && /可变/.test(evidence)) return options[1];
      return '';
    }
    if (no === '3.2') {
      var variablePolarity = inferredPolarity(raw, evidence);
      if (variablePolarity === 'no') return options[2];
      if (variablePolarity === 'yes' && /报告期末.{0,12}(?:已知|确定)|金额.{0,12}(?:已知|确定)/.test(evidence)) return options[1];
      if (variablePolarity === 'yes') return options[0];
      return '';
    }
    if (no === '1.4-M5') return /不涉及|转到第3部分|不作为单独合同/.test(evidence) ? options[1] : (/涉及|单独合同/.test(evidence) ? options[0] : '');
    if (no === '1.4-M8') {
      if (/结果2|前瞻法|终止现有合同/.test(evidence)) return options[0];
      if (/结果3|累计增加法/.test(evidence) && !/部分/.test(evidence)) return options[1];
      if (/结果4|部分前瞻|部分.*累计/.test(evidence)) return options[2];
    }
    if (no === '2.2.1-PVA9') {
      if (/主要责任人/.test(evidence)) return options[0];
      if (/代理人/.test(evidence)) return options[1];
    }
    if (no === '2.3-W2') {
      if (/一部分.{0,16}(?:可以|可选择).{0,8}购买|部分质保/.test(evidence)) return options[2];
      return inferredPolarity(raw, evidence) === 'yes' ? options[0] : (inferredPolarity(raw, evidence) === 'no' ? options[1] : '');
    }
    if (no === '2.3-W9') {
      if (/二者|是和否|保证型.{0,12}服务型|担保型.{0,12}服务型/.test(evidence)) return options[2];
      if (/服务型|提供服务/.test(evidence) && !/不向客户提供服务/.test(evidence)) return options[0];
      if (/保证型|担保型|不向客户提供服务/.test(evidence)) return options[1];
    }
    if (no === '3.2-VC3') {
      if (/期望值/.test(evidence)) return options[0];
      if (/最可能发生金额/.test(evidence)) return options[1];
    }
    if (no === '3.2-VC12') return /不会发生重大转回|无需.*限制/.test(evidence) ? options[1] : (/会发生重大转回|需要.*限制/.test(evidence) ? options[0] : '');
    if (no === '5.1.1-A4') return /产出法/.test(evidence) ? options[0] : (/投入法/.test(evidence) ? options[1] : '');
    if (no === '5.1.1-O2' || no === '5.1.1-I1') {
      return options.find(function (option) { return evidence.indexOf(option.replace(/^其他\s*-\s*/, '')) >= 0; }) || '';
    }
    var polarity = inferredPolarity(raw, evidence);
    var yesOptions = options.filter(function (option) { return answerPolarity(option) === 'yes'; });
    var noOptions = options.filter(function (option) { return answerPolarity(option) === 'no'; });
    if (polarity === 'yes' && yesOptions.length === 1) return yesOptions[0];
    if (polarity === 'no' && noOptions.length === 1) return noOptions[0];
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
      item.suggested_answer = '否';
      item.answer_reason = prefix + '，合同约定的是因质量问题进行退货、换货、修理或更换，属于正常质量保证安排而非回购。';
    } else if (hasGeneralReturn && !hasRepurchase) {
      item.suggested_answer = '否';
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
      item.suggested_answer = '是';
      polarity = 'yes';
    } else if (contrary && (lacksConclusion(item.suggested_answer) || !polarity)) {
      item.suggested_answer = '否';
      polarity = 'no';
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
        : '总体结论：五项条件未全部满足，建议1.2回答“否”，并进一步复核明确反向证据');

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
    item.suggested_answer = '是';
    delete item.answer_mapping_blocked;
    item.answer_reason = '当前输入仅包含补充协议或变更协议；补充文件已明确引用关联原合同，因此1.3按底稿固定选项给出倾向性答案“是”。仍应取得原合同并与补充/变更协议联合判断是否满足合同合并条件。';
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
        item.suggested_answer = '单项履约义务 - 多个商品和/或服务';
        appendReason(item, '现有条款显示多个组成部分共同形成组合产出或存在整合关系，初步作为单项履约义务；若各组成部分可分别交付、验收和使用，应重新评估');
      } else if (separateSignals >= 2) {
        item.suggested_answer = '多项履约义务';
        appendReason(item, '合同分别列示多种商品及其编号、数量或单价，且未见重大整合、重大定制或高度关联约定，现有证据更支持多项履约义务');
      }
      if (!item.confidence || confidenceRank(item.confidence) < 2) item.confidence = '中';
    }
    if (no === '3.2' && isCustomerLatePaymentPenalty(item) && !hasSalesPerformanceVariableTerm(item)) {
      item.suggested_answer = '否';
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

  var APPENDIX_TEMPLATES = {
    contractModification: '1.4 合同变更',
    performanceObligations: '2.1 履约义务',
    principalAgent: '2.2.1 PVA',
    warranty: '2.3 质保',
    variableConsideration: '3.2 可变对价',
    customerConsideration: '3.5 客户对价'
  };

  function parseStructuredArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return [value];
    var text = String(value || '').trim();
    if (!text) return [];
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      var parsed = JSON.parse(text);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch (e) {
      return [];
    }
    return [];
  }

  function firstNonEmpty(object, keys) {
    for (var i = 0; i < keys.length; i++) {
      var value = object && object[keys[i]];
      if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
    return '';
  }

  function positiveInteger(value) {
    var match = String(value || '').match(/\d+/);
    if (!match) return null;
    var result = parseInt(match[0], 10);
    return result >= 1 && result <= 5 ? result : null;
  }

  function normalizeTiming(value) {
    var text = norm(value);
    if (/overtime|时段|一段时间|在某一时段/.test(text)) return 'over_time';
    if (/pointintime|时点|某一时点/.test(text)) return 'point_in_time';
    return '';
  }

  function criterionPolarity(value) {
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (value && typeof value === 'object') {
      value = firstNonEmpty(value, ['met', 'answer', 'result', 'conclusion', 'value']);
    }
    return answerPolarity(value);
  }

  function timingFromCriteria(criteria) {
    criteria = parseStructuredArray(criteria);
    if (!criteria.length) return '';
    var answers = criteria.map(criterionPolarity).filter(Boolean);
    if (answers.indexOf('yes') >= 0) return 'over_time';
    // The workpaper has three over-time criteria. Incomplete criteria must not be
    // silently treated as a point-in-time conclusion.
    if (answers.length >= 3 && answers.every(function (answer) { return answer === 'no'; })) return 'point_in_time';
    return '';
  }

  function mergeStructuredObject(target, source) {
    Object.keys(source || {}).forEach(function (key) {
      var value = source[key];
      if ((target[key] === undefined || target[key] === null || target[key] === '') && value !== undefined && value !== null && value !== '') {
        target[key] = value;
      }
    });
    return target;
  }

  function buildPerformanceObligations(items) {
    var obligations = [];
    var byKey = {};
    var hasStructuredList = false;

    function add(raw, fallbackIndex) {
      if (typeof raw === 'string') raw = { name: raw };
      if (!raw || typeof raw !== 'object') return;
      var poNo = positiveInteger(firstNonEmpty(raw, ['po_no', 'poNo', 'number', 'no', 'index'])) || fallbackIndex;
      if (!poNo || poNo > 5) return;
      var name = String(firstNonEmpty(raw, ['name', 'po_name', 'obligation_name', 'performance_obligation', 'subject_name']) || ('PO#' + poNo)).trim();
      var criteria = parseStructuredArray(firstNonEmpty(raw, ['over_time_criteria', 'overTimeCriteria', 'criteria']));
      var timing = timingFromCriteria(criteria) || normalizeTiming(firstNonEmpty(raw, ['recognition_timing', 'timing', 'transfer_timing']));
      var normalizedPo = Object.assign({}, raw, {
        po_no: poNo,
        name: name,
        source_question: String(firstNonEmpty(raw, ['source_question', 'trigger_question']) || '2.1'),
        recognition_timing: timing,
        over_time_criteria: criteria
      });
      var key = String(poNo);
      if (!byKey[key]) {
        byKey[key] = normalizedPo;
        obligations.push(normalizedPo);
      } else {
        mergeStructuredObject(byKey[key], normalizedPo);
        if (!byKey[key].recognition_timing && timing) byKey[key].recognition_timing = timing;
        if ((!byKey[key].over_time_criteria || !byKey[key].over_time_criteria.length) && criteria.length) byKey[key].over_time_criteria = criteria;
      }
    }

    (items || []).forEach(function (item) {
      var parsed = parseStructuredArray(item.performance_obligations);
      if (parsed.length) hasStructuredList = true;
      parsed.forEach(function (po, index) { add(po, index + 1); });
    });

    // Backward compatibility: PO-specific Step 5 rows reveal the PO number even
    // when the old prompt returned only the flat items array.
    if (!hasStructuredList) {
      (items || []).forEach(function (item) {
        if (String(item.question_no || '').trim() !== '5.1') return;
        var match = String(item.workpaper_sheet || '').match(/PO#(\d+)/i);
        if (!match) return;
        var answer = String(item.suggested_answer || '').trim();
        var explicitlyNotApplicable = /不适用|无此履约义务|不存在(?:该|此)?履约义务/.test(answer);
        var hasDecision = !!answerPolarity(answer) && !explicitlyNotApplicable;
        var criteria = parseStructuredArray(item.over_time_criteria);
        var evidence = [item.contract_basis, item.answer_reason, item.contract_excerpt, item.supporting_evidence]
          .map(function (value) { return String(value || '').trim(); })
          .filter(function (value) { return value && !/^无$|不适用/.test(value); })
          .join(' ');
        if (!hasDecision && !criteria.length && evidence.length < 6) return;
        add({ po_no: match[1], name: item.po_name || ('PO#' + match[1]), source_question: '5.1' }, parseInt(match[1], 10));
      });
    }

    if (!hasStructuredList && !obligations.length) {
      var stepTwo = (items || []).find(function (item) { return String(item.question_no || '').trim() === '2.1'; });
      if (stepTwo) {
        var answer = String(stepTwo.suggested_answer || '');
        var countMatch = answer.match(/([1-5])\s*项履约义务/);
        var count = countMatch ? parseInt(countMatch[1], 10) : (/^单项履约义务/.test(answer) ? 1 : 0);
        for (var i = 1; i <= count; i++) add({ po_no: i, name: 'PO#' + i, source_question: '2.1' }, i);
      }
    }

    // Attach timing information returned on each PO's aggregate 5.1 item. The
    // 5.1.1/5.1.2 rows are appendix rows, not independent trigger decisions.
    obligations.forEach(function (po) {
      var timingItem = (items || []).find(function (item) {
        var poMatch = String(item.workpaper_sheet || '').match(/PO#(\d+)/i);
        return String(item.question_no || '').trim() === '5.1' && poMatch && parseInt(poMatch[1], 10) === po.po_no;
      });
      if (!timingItem) return;
      var criteria = parseStructuredArray(timingItem.over_time_criteria);
      var timing = timingFromCriteria(criteria);
      if (!timing) {
        var polarity = answerPolarity(timingItem.suggested_answer);
        timing = polarity === 'yes' ? 'over_time' : (polarity === 'no' ? 'point_in_time' : '');
      }
      if (criteria.length) po.over_time_criteria = criteria;
      if (timing) po.recognition_timing = timing;
    });

    return obligations.sort(function (a, b) { return a.po_no - b.po_no; }).slice(0, 5);
  }

  function hasStructuredPerformanceObligations(items) {
    return (items || []).some(function (item) {
      return parseStructuredArray(item && item.performance_obligations).length > 0;
    });
  }

  function poTransferPatternGroup(po) {
    var explicit = String(firstNonEmpty(po || {}, [
      'transfer_pattern_group', 'recognition_pattern_group', 'consistency_group'
    ]) || '').trim();
    if (explicit) return explicit;
    var serviceNature = String(firstNonEmpty(po || {}, ['service_nature', 'service_type']) || '').trim();
    if (serviceNature) return '服务性质：' + norm(serviceNature);
    var identity = norm([po && po.name, po && po.components].filter(Boolean).join('|'));
    return identity ? '履约义务：' + identity : '';
  }

  function poContextLine(po) {
    var parts = ['PO#' + po.po_no + '｜' + (po.name || '履约义务名称待核对')];
    if (po.components) parts.push('内容：' + po.components);
    if (po.service_nature) parts.push('服务性质：' + po.service_nature);
    if (poTransferPatternGroup(po)) parts.push('控制权转移模式组：' + poTransferPatternGroup(po));
    if (po.control_transfer_difference && !/^(?:无|不适用|相同)$/i.test(String(po.control_transfer_difference).trim())) {
      parts.push('与同组PO的明确差异：' + po.control_transfer_difference);
    }
    if (po.basis) parts.push('2.1识别依据：' + po.basis);
    return parts.join('；');
  }

  function poRegistryContext(obligations) {
    return '以下履约义务清单已经由2.1确认并锁定。后续第5步必须逐项使用，不得回答某个已列示PO“不存在”或“无此履约义务”。\n' +
      (obligations || []).map(poContextLine).join('\n') +
      '\n同一“控制权转移模式组”内，如服务性质和适用条款相同，相同指标必须采用一致结论；只有“与同组PO的明确差异”列示了具体条款差异时才可不同。';
  }

  function contextualPoQuestion(entry, po, obligations) {
    var cloned = Object.assign({}, entry);
    cloned.po_no = po.po_no;
    cloned.po_name = po.name || '';
    cloned.po_components = po.components || '';
    cloned.po_basis = po.basis || '';
    cloned.transfer_pattern_group = poTransferPatternGroup(po);
    cloned.poContext = poRegistryContext(obligations);
    cloned.question = '【已确认分析对象】' + poContextLine(po) + '。\n' + entry.question;
    return cloned;
  }

  function buildPerformanceObligationTimingQuestions(items) {
    var obligations = buildPerformanceObligations(items || []);
    if (!obligations.length) return [];
    return obligations.map(function (po) {
      var sheet = '第5a步（PO#' + po.po_no + '）';
      var entry = questions.find(function (question) {
        return question.sheet === sheet && question.questionNo === '5.1';
      });
      return entry ? contextualPoQuestion(entry, po, obligations) : null;
    }).filter(Boolean);
  }

  function poContextConflict(item, po) {
    if (!item || !po || !/^5\.1(?:\.|$)/.test(String(item.question_no || ''))) return false;
    var text = [item.suggested_answer, item.answer_reason, item.contract_basis, item.missing_information]
      .map(function (value) { return String(value || ''); }).join(' ');
    var exactPo = new RegExp('不存在\\s*(?:该|此)?\\s*PO#?\\s*' + po.po_no, 'i');
    return exactPo.test(text) || /无此履约义务|不存在(?:该|此)?履约义务/.test(text);
  }

  function applyPerformanceObligationContext(items) {
    var obligations = buildPerformanceObligations(items || []);
    var byNo = {};
    obligations.forEach(function (po) { byNo[po.po_no] = po; });
    var locked = hasStructuredPerformanceObligations(items);
    return (items || []).filter(function (item) {
      var match = String(item.workpaper_sheet || '').match(/PO#(\d+)/i);
      if (!match || !/^5\.1(?:\.|$)/.test(String(item.question_no || ''))) return true;
      return !locked || !!byNo[parseInt(match[1], 10)];
    }).map(function (item) {
      var match = String(item.workpaper_sheet || '').match(/PO#(\d+)/i);
      if (!match) return item;
      var po = byNo[parseInt(match[1], 10)];
      if (!po) return item;
      item.po_no = po.po_no;
      item.po_name = po.name || '';
      item.po_components = po.components || '';
      item.po_basis = po.basis || '';
      item.po_service_nature = String(firstNonEmpty(po, ['service_nature', 'service_type']) || '');
      item.transfer_pattern_group = poTransferPatternGroup(po);
      item.control_transfer_difference = String(po.control_transfer_difference || '');
      if (poContextConflict(item, po)) {
        item.po_context_conflict = true;
        item.suggested_answer = '不适用';
        var warning = '系统校验：PO#' + po.po_no + '“' + (po.name || '') + '”已在2.1确认存在，当前回答将其认定为不存在，不能采用。';
        if (String(item.answer_reason || '').indexOf(warning) < 0) item.answer_reason = warning + (item.answer_reason ? '；' + item.answer_reason : '');
        item.fill_readiness = '资料不足';
        item.confidence = '低';
        item.review_status = '需人工复核';
      }
      return item;
    });
  }

  function poAnswerClass(value) {
    var text = String(value || '').trim();
    if (/不适用|N\/?A/i.test(text)) return 'na';
    return answerPolarity(text) || (/资料不足|待复核|无法判断/.test(text) ? 'unknown' : norm(text));
  }

  function findPoConsistencyConflicts(items) {
    var obligations = buildPerformanceObligations(items || []);
    var byNo = {};
    obligations.forEach(function (po) { byNo[po.po_no] = po; });
    var buckets = {};
    (items || []).forEach(function (item) {
      if (!/^5\.1\.[12]-/.test(String(item.question_no || ''))) return;
      var match = String(item.workpaper_sheet || '').match(/PO#(\d+)/i);
      var po = match ? byNo[parseInt(match[1], 10)] : null;
      if (!po) return;
      var group = poTransferPatternGroup(po);
      if (!group) return;
      var key = group + '|' + item.question_no;
      if (!buckets[key]) buckets[key] = { key: key, group: group, question_no: item.question_no, entries: [] };
      buckets[key].entries.push({ item: item, po: po, answerClass: poAnswerClass(item.suggested_answer) });
    });
    return Object.keys(buckets).map(function (key) { return buckets[key]; }).filter(function (bucket) {
      if (bucket.entries.length < 2) return false;
      var hasExplicitDifference = bucket.entries.some(function (entry) {
        var value = String(entry.po.control_transfer_difference || '').trim();
        return value && !/^(?:无|不适用|相同)$/i.test(value);
      });
      if (hasExplicitDifference) return false;
      return uniqueValues(bucket.entries.map(function (entry) { return entry.answerClass; })).length > 1;
    });
  }

  function buildPoConsistencyReviewQuestions(items) {
    var obligations = buildPerformanceObligations(items || []);
    var seen = {};
    var questionsForReview = [];
    findPoConsistencyConflicts(items || []).forEach(function (conflict) {
      conflict.entries.forEach(function (entry) {
        var match = findQuestion(entry.item);
        if (!match) return;
        var contextual = contextualPoQuestion(match, entry.po, obligations);
        contextual.consistency_review = true;
        var key = questionKey(contextual);
        if (!seen[key]) {
          seen[key] = true;
          questionsForReview.push(contextual);
        }
      });
    });
    return questionsForReview;
  }

  function markPoConsistencyConflicts(items) {
    findPoConsistencyConflicts(items || []).forEach(function (conflict) {
      conflict.entries.forEach(function (entry) {
        var item = entry.item;
        var warning = '系统一致性复核：同一控制权转移模式组“' + conflict.group + '”的相同指标出现不一致答案，且未列明差异条款。';
        if (String(item.answer_reason || '').indexOf(warning) < 0) item.answer_reason = warning + (item.answer_reason ? '；' + item.answer_reason : '');
        item.po_consistency_conflict = true;
        item.fill_readiness = '建议填入，需复核';
        item.confidence = '低';
        item.review_status = '需人工复核';
      });
    });
    return items || [];
  }

  function structuredEvidenceIds(value) {
    var ids = parseStructuredArray(value).map(function (entry) {
      if (typeof entry === 'string' || typeof entry === 'number') return String(entry).trim();
      return String(firstNonEmpty(entry, ['fact_id', 'id']) || '').trim();
    }).filter(Boolean);
    return uniqueValues(ids);
  }

  function inheritedDetailItem(source, suffix) {
    source = source || {};
    return {
      id: String(source.id || 'revenue') + '__' + suffix,
      contractId: source.contractId || '',
      ruleId: source.ruleId || 'revenue_workpaper',
      ruleVersion: source.ruleVersion || '',
      fieldKeys: source.fieldKeys,
      fieldSetId: source.fieldSetId,
      extractAt: source.extractAt,
      versionLabel: source.versionLabel,
      contract_basis: source.contract_basis || '',
      sop_basis: source.sop_basis || 'SOP > 第五步：在实体履约义务时确认收入 > 控制权转移判断',
      answer_reason: source.answer_reason || '',
      contract_excerpt: source.contract_excerpt || '',
      source_documents: source.source_documents || '',
      supporting_evidence: source.supporting_evidence || '',
      missing_information: source.missing_information || '无',
      triggered_sheet: '无',
      appendix_status: '未触发',
      fill_readiness: source.fill_readiness || '建议填入，需复核',
      pages: source.pages || '',
      confidence: source.confidence || '中',
      review_status: source.review_status || '需人工复核'
    };
  }

  function expandStructuredDetails(items) {
    var baseItems = (items || []).filter(function (item) { return !item._structured_detail; });
    var generated = [];
    var obligations = buildPerformanceObligations(baseItems);
    var stepTwo = baseItems.find(function (item) { return String(item.question_no || '').trim() === '2.1'; });
    var showObligationSheet = stepTwo && /(多项履约义务|单项履约义务.{0,12}(?:多个|多项)商品)/.test(String(stepTwo.suggested_answer || ''));

    if (showObligationSheet) {
      obligations.forEach(function (po) {
        var source = baseItems.find(function (item) {
          return String(item.question_no || '').trim() === String(po.source_question || '2.1');
        }) || stepTwo || {};
        var detail = inheritedDetailItem(source, 'po_' + po.po_no);
        var capable = String(firstNonEmpty(po, ['capable_of_being_distinct', 'capable_distinct']) || '资料不足');
        var context = String(firstNonEmpty(po, ['distinct_in_contract_context', 'distinct_in_context']) || '资料不足');
        var conclusion = String(firstNonEmpty(po, ['conclusion', 'status']) || '需复核');
        detail.workpaper_sheet = '2.1 履约义务';
        detail.workpaper_row = String(5 + po.po_no);
        detail.question_no = '2.1-PO#' + po.po_no;
        detail.question_description = 'PO#' + po.po_no + '：' + po.name + (po.components ? '（' + po.components + '）' : '');
        detail.suggested_answer = '能够单独区分：' + capable + '；在合同背景下可明确区分：' + context + '；结论：' + conclusion;
        detail.contract_basis = String(po.components || detail.contract_basis || '');
        detail.answer_reason = String(po.basis || detail.answer_reason || '');
        detail.evidence_fact_ids = JSON.stringify(structuredEvidenceIds(firstNonEmpty(po, ['evidence_fact_ids', 'fact_ids'])));
        detail._structured_detail = 'performance_obligation';
        generated.push(detail);
      });
    }

    obligations.forEach(function (po) {
      var sheet = '第5a步（PO#' + po.po_no + '）';
      var source = baseItems.find(function (item) {
        return String(item.question_no || '').trim() === '5.1' && String(item.workpaper_sheet || '') === sheet;
      });
      if (!source) return;
      var criteria = parseStructuredArray(source.over_time_criteria).slice(0, 3);
      criteria.forEach(function (criterion, index) {
        var number = positiveInteger(firstNonEmpty(criterion, ['criterion_no', 'number', 'no'])) || (index + 1);
        if (number < 1 || number > 3) return;
        var detail = inheritedDetailItem(source, 'po_' + po.po_no + '_criterion_' + number);
        detail.workpaper_sheet = sheet;
        detail.workpaper_row = String(5 + number);
        detail.question_no = '5.1-C' + number;
        detail.question_description = stepFiveCriteria[number - 1];
        detail.suggested_answer = String(firstNonEmpty(criterion, ['result', 'answer', 'conclusion']) || '资料不足');
        detail.contract_basis = String(firstNonEmpty(criterion, ['basis', 'reason']) || detail.contract_basis || '');
        detail.answer_reason = String(firstNonEmpty(criterion, ['basis', 'reason']) || detail.answer_reason || '');
        detail.evidence_fact_ids = JSON.stringify(structuredEvidenceIds(firstNonEmpty(criterion, ['evidence_fact_ids', 'fact_ids'])));
        detail._structured_detail = 'step_five_criterion';
        generated.push(detail);
      });
    });

    return baseItems.concat(generated);
  }

  function questionKey(item) {
    return String((item || {}).workpaper_sheet || (item || {}).sheet || '').trim() + '|' +
      String((item || {}).question_no || (item || {}).questionNo || '').trim();
  }

  function buildTriggeredDetailQuestions(items) {
    var normalized = normalizeResults(items || []);
    var existing = {};
    normalized.forEach(function (item) { existing[questionKey(item)] = true; });
    var wanted = [];
    var obligations = buildPerformanceObligations(normalized);
    obligations.forEach(function (po) {
      var sheet = po.recognition_timing === 'over_time'
        ? '5.1.1 时段（PO#' + po.po_no + '）'
        : (po.recognition_timing === 'point_in_time' ? '5.1.2 时点（PO#' + po.po_no + '）' : '');
      if (!sheet) return;
      detailQuestions.filter(function (entry) { return entry.sheet === sheet; }).forEach(function (entry) {
        var contextual = contextualPoQuestion(entry, po, obligations);
        var candidate = {
          workpaper_sheet: contextual.sheet,
          question_no: contextual.questionNo,
          question_description: contextual.question,
          appendix_instance_no: po.po_no
        };
        if (!existing[questionKey(contextual)] && isVisible(candidate, normalized)) wanted.push(contextual);
      });
    });
    buildAppendixPlan(normalized).forEach(function (planEntry) {
      var templateSheet = normalizeTemplateSheet(planEntry.template_sheet);
      if (!appendixQuestionTemplates[templateSheet]) return;
      var displaySheet = String(planEntry.display_name || templateSheet);
      detailQuestions.filter(function (entry) { return entry.sheet === templateSheet; }).forEach(function (entry) {
        var cloned = Object.assign({}, entry, {
          sheet: displaySheet,
          question: planEntry.subject_name
            ? '分析对象：' + planEntry.subject_name + '。' + entry.question
            : entry.question,
          subject_id: planEntry.subject_id || '',
          appendix_instance_no: planEntry.instance_no || 1
        });
        var candidate = {
          workpaper_sheet: cloned.sheet,
          question_no: cloned.questionNo,
          question_description: cloned.question,
          subject_id: cloned.subject_id,
          appendix_instance_no: cloned.appendix_instance_no
        };
        if (!existing[questionKey(cloned)] && isVisible(candidate, normalized)) wanted.push(cloned);
      });
    });
    return wanted;
  }

  function normalizeTemplateSheet(value) {
    var text = String(value || '').trim();
    if (/^1\.4/.test(text)) return APPENDIX_TEMPLATES.contractModification;
    if (/^2\.1(?:\s|履)/.test(text)) return APPENDIX_TEMPLATES.performanceObligations;
    if (/^2\.2\.1|PVA|主要责任人|代理人/i.test(text)) return APPENDIX_TEMPLATES.principalAgent;
    if (/^2\.3/.test(text)) return APPENDIX_TEMPLATES.warranty;
    if (/^3\.2/.test(text)) return APPENDIX_TEMPLATES.variableConsideration;
    if (/^3\.5|应付客户对价/.test(text)) return APPENDIX_TEMPLATES.customerConsideration;
    var poMatch = text.match(/PO#(\d+)/i);
    if (poMatch && /5\.1\.1|时段/.test(text)) return '5.1.1 时段（PO#' + poMatch[1] + '）';
    if (poMatch && /5\.1\.2|时点/.test(text)) return '5.1.2 时点（PO#' + poMatch[1] + '）';
    if (poMatch && /第5a步/i.test(text)) return '第5a步（PO#' + poMatch[1] + '）';
    return '';
  }

  function structuredSubjects(item, templateSheet) {
    var subjects = [];
    parseStructuredArray(item && item.appendix_subjects).forEach(function (subject) {
      if (typeof subject === 'string') subject = { name: subject };
      if (!subject || typeof subject !== 'object') return;
      var subjectTemplate = normalizeTemplateSheet(firstNonEmpty(subject, ['template_sheet', 'sheet', 'appendix_type']));
      if (subjectTemplate && subjectTemplate !== templateSheet) return;
      subjects.push(subject);
    });
    parseStructuredArray(item && item.appendix_plan).forEach(function (entry) {
      if (!entry || typeof entry !== 'object') return;
      if (normalizeTemplateSheet(firstNonEmpty(entry, ['template_sheet', 'sheet', 'display_name'])) !== templateSheet) return;
      subjects.push(entry);
    });
    return subjects;
  }

  function buildAppendixPlan(items) {
    var plan = [];
    var seen = {};
    var obligations = buildPerformanceObligations(items);

    function add(templateSheet, displayName, triggerQuestion, options) {
      options = options || {};
      templateSheet = normalizeTemplateSheet(templateSheet);
      if (!templateSheet) return;
      var subjectName = String(options.subject_name || '').trim();
      var subjectId = String(options.subject_id || '').trim();
      var key = [templateSheet, options.po_no || '', subjectId || norm(subjectName) || options.instance_no || '1'].join('|');
      if (seen[key]) return;
      seen[key] = true;
      plan.push({
        template_sheet: templateSheet,
        display_name: displayName || templateSheet,
        instance_no: options.instance_no || 1,
        subject_id: subjectId,
        related_subject_id: String(options.related_subject_id || '').trim(),
        subject_name: subjectName,
        trigger_question: triggerQuestion,
        po_no: options.po_no || '',
        appendix_type: options.appendix_type || '',
        status: String(options.status || '').trim()
      });
    }

    function addSubjects(item, templateSheet, baseDisplayName, triggerQuestion, appendixType) {
      var subjects = structuredSubjects(item, templateSheet).slice(0, 5);
      if (!subjects.length) {
        add(templateSheet, baseDisplayName, triggerQuestion, { appendix_type: appendixType });
        return;
      }
      subjects.forEach(function (subject, index) {
        var subjectName = String(firstNonEmpty(subject, ['subject_name', 'subject', 'name', 'type', 'display_name']) || '').trim();
        var subjectId = String(firstNonEmpty(subject, ['subject_id', 'id', 'code']) || '').trim();
        var relatedSubjectId = String(firstNonEmpty(subject, ['related_subject_id', 'relatedSubjectId']) || '').trim();
        var suffix = subjectName.replace(/^\d+(?:\.\d+)*\s*/, '').replace(/^(?:可变对价|主要责任人和代理人|PVA|质保)\s*[-－:]?\s*/, '');
        add(templateSheet, suffix ? baseDisplayName + '-' + suffix : baseDisplayName, triggerQuestion, {
          instance_no: index + 1,
          subject_id: subjectId,
          related_subject_id: relatedSubjectId,
          subject_name: subjectName,
          appendix_type: appendixType,
          status: firstNonEmpty(subject, ['status', 'appendix_status'])
        });
      });
    }

    function addSingleWithSubjects(item, templateSheet, displayName, triggerQuestion, appendixType) {
      var subjects = structuredSubjects(item, templateSheet).slice(0, 5);
      var names = uniqueValues(subjects.map(function (subject) {
        return firstNonEmpty(subject, ['subject_name', 'subject', 'name', 'type']);
      }));
      var first = subjects[0] || {};
      add(templateSheet, displayName, triggerQuestion, {
        subject_id: firstNonEmpty(first, ['subject_id', 'id', 'code']),
        related_subject_id: firstNonEmpty(first, ['related_subject_id', 'relatedSubjectId']),
        subject_name: names.join('；'),
        appendix_type: appendixType,
        status: firstNonEmpty(first, ['status', 'appendix_status'])
      });
    }

    (items || []).forEach(function (item) {
      if (!isVisible(item, items || [])) return;
      var no = String(item.question_no || '').trim();
      var polarity = answerPolarity(item.suggested_answer);
      if (no === '1.4' && polarity === 'yes') add(APPENDIX_TEMPLATES.contractModification, APPENDIX_TEMPLATES.contractModification, no, { appendix_type: 'contract_modification' });
      if (no === '2.1' && /(多项履约义务|单项履约义务.{0,12}(?:多个|多项)商品)/.test(String(item.suggested_answer || ''))) {
        add(APPENDIX_TEMPLATES.performanceObligations, APPENDIX_TEMPLATES.performanceObligations, no, { appendix_type: 'performance_obligations' });
      }
      if (no === '2.2.1' && polarity === 'yes') addSubjects(item, APPENDIX_TEMPLATES.principalAgent, '2.2.1 主要责任人和代理人', no, 'principal_agent');
      if (no === '2.3' && polarity === 'yes') addSubjects(item, APPENDIX_TEMPLATES.warranty, APPENDIX_TEMPLATES.warranty, no, 'warranty');
      if (no === '3.2' && polarity === 'yes') addSubjects(item, APPENDIX_TEMPLATES.variableConsideration, APPENDIX_TEMPLATES.variableConsideration, no, 'variable_consideration');
      if (no === '3.5' && polarity === 'yes') addSingleWithSubjects(item, APPENDIX_TEMPLATES.customerConsideration, '3.5 应付客户对价', no, 'customer_consideration');
    });

    obligations.forEach(function (po) {
      add('第5a步（PO#' + po.po_no + '）', '第5a步（PO#' + po.po_no + '）', '5.1', {
        po_no: po.po_no,
        subject_name: po.name,
        appendix_type: 'performance_obligation'
      });
      if (po.recognition_timing === 'over_time') {
        add('5.1.1 时段（PO#' + po.po_no + '）', '5.1.1 时段（PO#' + po.po_no + '）', '5.1', {
          po_no: po.po_no,
          subject_name: po.name,
          appendix_type: 'recognition_timing'
        });
      } else if (po.recognition_timing === 'point_in_time') {
        add('5.1.2 时点（PO#' + po.po_no + '）', '5.1.2 时点（PO#' + po.po_no + '）', '5.1', {
          po_no: po.po_no,
          subject_name: po.name,
          appendix_type: 'recognition_timing'
        });
      }
    });

    return plan;
  }

  function applyResolvedAppendixPlan(items) {
    var plan = buildAppendixPlan(items);
    (items || []).forEach(function (item) {
      var no = String(item.question_no || '').trim();
      var poMatch = String(item.workpaper_sheet || '').match(/PO#(\d+)/i);
      var poNo = poMatch ? parseInt(poMatch[1], 10) : null;
      var relevant = plan.filter(function (entry) {
        if (entry.trigger_question !== no) return false;
        return !entry.po_no || !poNo || Number(entry.po_no) === poNo;
      });
      var names = uniqueValues(relevant.map(function (entry) { return entry.display_name; }));
      // Always replace the model-provided value. Sheet selection is a controlled
      // workpaper rule and must not be accepted as free-form model output.
      item.triggered_sheet = names.length ? names.join('；') : '无';
      item.appendix_status = inferAppendixStatus(item);
    });
    return items || [];
  }

  function inferTriggeredSheet(item) {
    var polarity = answerPolarity(item.suggested_answer);
    var no = String(item.question_no || '').trim();
    if (no === '2.2') return '无';
    if (no === '2.2.1') return polarity === 'yes' ? '2.2.1 主要责任人和代理人' : '无';
    if (no === '1.4') return polarity === 'yes' ? '1.4 合同变更' : '无';
    if (no === '2.1' && /(多项履约义务|单项履约义务.{0,12}(?:多个|多项)商品)/.test(String(item.suggested_answer || ''))) return '2.1 履约义务';
    if (polarity !== 'yes') return '无';
    if (no === '2.1') return '2.1 履约义务';
    if (no === '2.3') return '2.3 质保';
    if (no === '3.2') return '3.2 可变对价';
    if (no === '3.5') return '3.5 应付客户对价';
    if (no === '5.1') {
      var poMatch = String(item.workpaper_sheet || '').match(/PO#(\d+)/i);
      var po = poMatch ? poMatch[1] : '1';
      var timing = polarity === 'no' ? '5.1.2 时点' : '5.1.1 时段';
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
    item = normalizeTemplateSuggestedAnswer(item);
    ensureRequiredMissingInformation(item);
    if (['高', '中', '低'].indexOf(String(item.confidence || '').trim()) < 0) {
      item.confidence = '低';
    }
    if (['需人工复核', '可复核后采用'].indexOf(String(item.review_status || '').trim()) < 0) {
      item.review_status = '需人工复核';
    }
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
    if (typeof item === 'object' && item) {
      var detailMatch = findQuestion(item);
      var detailDependency = item.dependencies || (detailMatch && detailMatch.dependencies);
      if (detailDependency) return Object.assign({ scoped: true }, detailDependency);
    }
    return questionDependencies.find(function (dependency) {
      return dependency.targetQuestionNo === no;
    }) || null;
  }

  function sameDependencyScope(target, candidate) {
    var targetSubject = String((target || {}).subject_id || '').trim();
    var candidateSubject = String((candidate || {}).subject_id || '').trim();
    if (targetSubject || candidateSubject) return !!targetSubject && targetSubject === candidateSubject;
    var targetSheet = String((target || {}).workpaper_sheet || '').trim();
    var candidateSheet = String((candidate || {}).workpaper_sheet || '').trim();
    var targetInstance = positiveInteger((target || {}).appendix_instance_no) || 1;
    var candidateInstance = positiveInteger((candidate || {}).appendix_instance_no) || 1;
    return targetSheet === candidateSheet && targetInstance === candidateInstance;
  }

  function conditionMatches(condition, target, dependency, items, stack) {
    return (items || []).some(function (candidate) {
      if (String(candidate.question_no || '').trim() !== condition.questionNo) return false;
      if (dependency.scoped && !sameDependencyScope(target, candidate)) return false;
      if (!isVisibleInternal(candidate, items, stack)) return false;
      var polarity = templateAnswerPolarity(condition.questionNo, candidate.suggested_answer);
      if (condition.operator === 'yes') return polarity === 'yes';
      if (condition.operator === 'no') return polarity === 'no';
      if (condition.operator === 'contains') {
        return String(candidate.suggested_answer || '').indexOf(String(condition.value || '')) >= 0;
      }
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
    var conditionGroups = dependency.groups || [dependency.conditions || []];
    var groupMatches = conditionGroups.map(function (group) {
      var matches = group.map(function (condition) {
        return conditionMatches(condition, item, dependency, items, nextStack);
      });
      return dependency.match === 'any' ? matches.some(Boolean) : matches.every(Boolean);
    });
    if (dependency.groups) return groupMatches.some(Boolean);
    var matches = conditionGroups[0].map(function (condition) {
      return conditionMatches(condition, item, dependency, items, nextStack);
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

  function questionSortRank(item) {
    var no = String((item || {}).question_no || '').trim();
    var sheet = String((item || {}).workpaper_sheet || '').trim();
    var obligationMatch = no.match(/^2\.1-PO#(\d+)$/i);
    if (obligationMatch) {
      var stepTwoIndex = questions.findIndex(function (entry) { return entry.sheet === '第2步' && entry.questionNo === '2.1'; });
      return stepTwoIndex + parseInt(obligationMatch[1], 10) / 100;
    }
    var criterionMatch = no.match(/^5\.1-C([1-3])$/i);
    var poMatch = sheet.match(/PO#(\d+)/i);
    if (poMatch && (criterionMatch || /^5\.1\.[12]-/.test(no))) {
      var stepSheet = '第5a步（PO#' + poMatch[1] + '）';
      var stepIndex = questions.findIndex(function (entry) { return entry.sheet === stepSheet && entry.questionNo === '5.1'; });
      if (criterionMatch) return stepIndex + parseInt(criterionMatch[1], 10) / 100;
      var detail = findQuestion(item);
      return stepIndex + 2.1 + ((detail && detail.row) || 0) / 1000;
    }
    var triggerNo = '';
    if (/^1\.4-M/.test(no)) triggerNo = '1.4';
    else if (/^2\.2\.1-PVA/.test(no)) triggerNo = '2.2.1';
    else if (/^2\.3-W/.test(no)) triggerNo = '2.3';
    else if (/^3\.2-VC/.test(no)) triggerNo = '3.2';
    else if (/^3\.5-PC/.test(no)) triggerNo = '3.5';
    if (triggerNo) {
      var triggerIndex = questions.findIndex(function (entry) { return entry.questionNo === triggerNo; });
      var detailQuestion = findQuestion(item);
      return triggerIndex + 0.1 + ((detailQuestion && detailQuestion.row) || 0) / 1000;
    }
    var match = findQuestion(item);
    var index = match ? questions.indexOf(match) : -1;
    return index >= 0 ? index : 9999;
  }

  function isGeneralInformationItem(item) {
    return /^GI\.[1-5]$/.test(String((item || {}).question_no || '').trim());
  }

  function hasGeneralInformation(items) {
    var found = {};
    (items || []).forEach(function (item) {
      var no = String((item || {}).question_no || '').trim();
      if (/^GI\.[1-5]$/.test(no)) found[no] = true;
    });
    return generalInfoQuestions.every(function (question) { return !!found[question.questionNo]; });
  }

  function preserveGeneralInformation(sourceItems, reviewedItems) {
    var sourceByNo = {};
    var combined = (reviewedItems || []).slice();
    (sourceItems || []).forEach(function (item) {
      if (isGeneralInformationItem(item)) sourceByNo[String(item.question_no).trim()] = item;
    });
    generalInfoQuestions.forEach(function (question) {
      var exists = combined.some(function (item) { return String((item || {}).question_no || '').trim() === question.questionNo; });
      if (!exists && sourceByNo[question.questionNo]) combined.push(sourceByNo[question.questionNo]);
    });
    return normalizeResults(combined);
  }

  function normalizeResults(items) {
    items = expandStructuredDetails(items || []);
    items = applyPerformanceObligationContext(items);
    var dedup = {};
    items.forEach(function (item) {
      var originalSheet = String(item.workpaper_sheet || '').trim();
      var match = findQuestion(item);
      if (match) {
        item.workpaper_match_status = norm(item.question_description) === norm(match.question)
          ? '已定位（工作表、编号、问题描述一致）'
          : '已定位（请核对问题描述）';
        item.workpaper_sheet = match.detailType === 'triggered_appendix' && originalSheet
          ? originalSheet
          : match.sheet;
        item.workpaper_template_sheet = match.sheet;
        item.workpaper_row = String(match.row);
        item.question_no = match.questionNo;
        item.question_description = match.question;
        item.display_question_no = match.displayQuestionNo || match.questionNo;
        item.display_question_description = match.displayQuestion || match.question;
        item.workpaper_section = match.displaySection || '';
        if (match.detailType) item.appendix_detail_type = match.detailType;
      }
      item = applySopPolicy(item);
      var key = match
        ? [item.workpaper_sheet || match.sheet, match.row, item.subject_id || item.appendix_instance_no || ''].join('|')
        : [item.workpaper_sheet, item.question_no, norm(item.question_description)].join('|');
      if (!dedup[key] || itemScore(item) > itemScore(dedup[key])) dedup[key] = item;
    });
    var normalized = Object.keys(dedup).map(function (key) { return dedup[key]; }).sort(function (a, b) {
      return questionSortRank(a) - questionSortRank(b);
    });
    normalized = applyConditionalVisibility(normalized);
    normalized = applyResolvedAppendixPlan(normalized);
    return markPoConsistencyConflicts(normalized);
  }

  function visibleItems(items) {
    return normalizeResults(items).filter(function (item) { return !item.conditional_hidden; });
  }

  function buildChecklistRows(contract, items) {
    return visibleItems(items).map(function (item, index) {
      var match = findQuestion(item);
      var descriptionMatches = match && norm(item.question_description) === norm(match.question);
      var displayDescription = item.display_question_description || (match && match.displayQuestion) || item.question_description || '';
      if (item.po_name && /^5\.1(?:\.|$)/.test(String(item.question_no || ''))) {
        displayDescription = 'PO#' + item.po_no + '—' + item.po_name + '｜' + displayDescription;
      }
      var matchStatus = item.workpaper_match_status || (match
        ? (descriptionMatches ? '已定位（工作表、编号、问题描述一致）' : '已定位（请核对问题描述）')
        : '未定位（请按问题描述人工匹配）');
      var needsReview = !match || /需|是|yes|true/i.test(String(item.review_status || '')) ||
        confidenceRank(item.confidence) < 3 || item.fill_readiness !== '可直接填入';
      return {
        '序号': index + 1,
        '合同名称': contract ? contract.file : '',
        '参考底稿版本': 'V2 U_GP SWP 合同审阅示例底稿',
        '工作表名称': item.workpaper_sheet || (match ? match.sheet : ''),
        '底稿行号': match ? match.row : (item.workpaper_row || ''),
        '底稿章节': item.workpaper_section || (match && match.displaySection) || '',
        '问题编号': item.display_question_no || (match && match.displayQuestionNo) || item.question_no || '',
        '问题描述': displayDescription,
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

  function fallbackFactId(fact, index) {
    if (fact && fact.fact_id) return String(fact.fact_id);
    var value = [fact && fact.source_document, fact && fact.pages, fact && fact.fact_summary, index].join('|');
    var hash = 2166136261;
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return 'RF-' + (hash >>> 0).toString(16);
  }

  function bindEvidenceRefs(items, facts) {
    var factMap = {};
    (facts || []).forEach(function (fact, index) {
      var id = fallbackFactId(fact, index);
      factMap[id] = fact;
      if (fact && !fact.fact_id) fact.fact_id = id;
    });
    (items || []).forEach(function (item) {
      var ids = structuredEvidenceIds(item.evidence_fact_ids);
      var refs = [];
      ids.forEach(function (id) {
        var fact = factMap[id];
        if (!fact) return;
        refs.push({
          fact_id: id,
          source_id: String(fact.source_id || ''),
          source_document: String(fact.source_document || ''),
          pages: String(fact.pages || '【页码未知】')
        });
      });
      if (!refs.length) {
        parseStructuredArray(item.evidence_refs).forEach(function (ref) {
          if (!ref || typeof ref !== 'object') return;
          var source = String(firstNonEmpty(ref, ['source_document', 'source', 'file']) || '').trim();
          var pages = String(firstNonEmpty(ref, ['pages', 'page']) || '').trim();
          if (source) refs.push({ source_id: String(ref.source_id || ''), source_document: source, pages: pages || '【页码未知】' });
        });
      }
      var seen = {};
      refs = refs.filter(function (ref) {
        var key = [ref.source_id, ref.source_document, ref.pages].join('|');
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });
      if (!refs.length) return;
      item.evidence_refs = JSON.stringify(refs);
      item.source_documents = uniqueValues(refs.map(function (ref) { return ref.source_document; })).join('；');
      item.pages = uniqueValues(refs.map(function (ref) { return ref.pages; })).join('、');
    });
    return items || [];
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
    bindEvidenceRefs(normalized, facts);
    if (!paymentFacts.length) return normalized;
    var paymentText = paymentFacts.map(function (f) { return String(f.fact_summary || '') + ' ' + String(f.contract_excerpt || '') + ' ' + String(f.qualifier || ''); }).join(' ');
    var paymentSummary = uniqueValues(paymentFacts.map(function (f) { return f.fact_summary; })).slice(0, 3).join('；');
    var paymentSources = uniqueValues(paymentFacts.map(function (f) { return f.source_document; })).join('；');
    var paymentPages = uniqueValues(paymentFacts.map(function (f) { return f.pages; })).slice(0, 3).join('、');
    var paymentFactIds = uniqueValues(paymentFacts.map(function (fact, index) { return fallbackFactId(fact, index); }));
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
        item.evidence_fact_ids = JSON.stringify(uniqueValues(structuredEvidenceIds(item.evidence_fact_ids).concat(paymentFactIds)));
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
        item.evidence_fact_ids = JSON.stringify(paymentFactIds);
        item.confidence = refersWorkStatement && !hasWorkStatement ? '中' : '高';
        item.fill_readiness = refersWorkStatement && !hasWorkStatement ? '建议填入，需复核' : '可直接填入';
        item.review_status = refersWorkStatement && !hasWorkStatement ? '需人工复核' : '可复核后采用';
      }
      applySopPolicy(item);
      delete item._sharedPaymentConfirmed;
    });
    bindEvidenceRefs(normalized, facts);
    return applyResolvedAppendixPlan(applyConditionalVisibility(normalized));
  }

  function buildMissingTasks(items) {
    var map = {};
    visibleItems(items).forEach(function (item) {
      var text = String(item.missing_information || '').trim();
      if (isNoMissingInformation(text)) return;
      if (!map[text]) map[text] = { text: text, questionNos: [], blocking: false };
      var displayNo = item.display_question_no || item.question_no;
      if (map[text].questionNos.indexOf(displayNo) < 0) map[text].questionNos.push(displayNo);
      if (item.fill_readiness === '资料不足') map[text].blocking = true;
    });
    return Object.keys(map).map(function (key) { return map[key]; });
  }

  global.REVENUE_WORKPAPER_QUESTIONS = questions;
  global.RevenueWorkpaper = {
    questions: questions,
    detailQuestions: detailQuestions,
    questionDependencies: questionDependencies,
    findQuestion: findQuestion,
    normalizeResults: normalizeResults,
    buildPerformanceObligations: buildPerformanceObligations,
    buildPerformanceObligationTimingQuestions: buildPerformanceObligationTimingQuestions,
    buildAppendixPlan: buildAppendixPlan,
    buildTriggeredDetailQuestions: buildTriggeredDetailQuestions,
    buildPoConsistencyReviewQuestions: buildPoConsistencyReviewQuestions,
    findPoConsistencyConflicts: findPoConsistencyConflicts,
    applyConditionalVisibility: applyConditionalVisibility,
    visibleItems: visibleItems,
    isVisible: isVisible,
    buildChecklistRows: buildChecklistRows,
    applySharedFacts: applySharedFacts,
    bindEvidenceRefs: bindEvidenceRefs,
    buildMissingTasks: buildMissingTasks,
    hasGeneralInformation: hasGeneralInformation,
    preserveGeneralInformation: preserveGeneralInformation,
    answerOptions: TEMPLATE_ANSWER_OPTIONS
  };
})(window);
