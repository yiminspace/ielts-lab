// Original learning material written for IELTS Lab. These are short section/task
// practices, not official questions or a complete General Training test.
const provenance = "原创 G 类专项练习，非官方真题或完整模拟考试。";
const item = (id, kind, title, description, data, count = 1) => ({
  id,
  kind,
  title,
  collection: "G 类原创练习",
  testTrack: "general",
  source: "original",
  description: `${description} ${provenance}`,
  count,
  data,
  localMedia: {},
});
const solution = (correctValue, explain, quote = "") => ({
  correctValue,
  explain,
  ...(quote
    ? { articleSourceHighlight: { data: [{ evidence: { text: quote } }] } }
    : {}),
});
const group = (id, type, start, description, question, answers) => ({
  questionId: id,
  questionType: type,
  questionCount: answers.length,
  questionJson: {
    questionType: String(type),
    startIndex: start,
    endIndex: start + answers.length - 1,
    questionNum: answers.length,
    descriptions: description,
    ...question,
  },
  answerJson: answers,
});
const choice = (content, options) => ({
  content,
  options: options.map((text) => ({ content: text })),
});

const everydayNotices = `
<h2>Maple Junction community noticeboard</h2>
<h3>A · Borrow more, buy less</h3>
<p>The Maple Junction Tool Library lends household equipment to adult residents. To join, bring photo identification and a recent bill showing your home address to the library desk. Membership costs £12 a year; there is no separate charge for each loan. You may borrow two items at a time for up to seven days. Extensions are possible only when nobody else has reserved the equipment. Small electrical items must be tested by staff when they are returned, so please allow ten minutes for this. Collection and return are available on Tuesday evenings and Saturday mornings. The online catalogue shows what is available, but membership registration must be completed in person.</p>
<h3>B · Cook together on Thursday</h3>
<p>Our evening cooking workshop is suitable for adults with little experience in the kitchen. Each group prepares a simple meal and eats it together at the end. Ingredients and cooking equipment are included in the £18 fee, but participants should bring an apron. Tell us about any food allergies when booking. Places must be reserved in advance because the kitchen holds only twelve people. If you cancel at least three days before the workshop, we will return your payment in full. Later cancellations cannot be refunded, although you may give your place to a friend. Please arrive by 18:15 for the kitchen introduction.</p>
<h3>C · Saturday repair afternoon</h3>
<p>Bring a broken bag, a loose chair leg or a small household object to the repair afternoon in the community hall. No appointment is needed: visitors are seen in order of arrival. The event runs from 12:00 to 15:00, with the last new item accepted at 14:30. Volunteers will discuss possible repairs with you, and you are encouraged to help rather than leave the object behind. Advice is free, but replacement parts must be paid for. We cannot accept phones or computers because we do not have a specialist available. Successful repairs cannot be guaranteed, so please take your item home even if we are unable to fix it.</p>
<h3>D · Seeds and stories</h3>
<p>The monthly garden exchange takes place beside the park gate. Leave donated seeds in the green box and label them with the plant name and the year they were collected. Seedlings should go on the table, where there is more protection from passing bicycles. You are welcome to take something even if you have nothing to exchange. A volunteer gardener is available from 10:00 to 11:00 to answer questions, although the exchange table stays open until noon. Please bring your own bag. Any seeds remaining at the end will be used by the school gardening club, so do not leave containers that you need returned.</p>`;

const workplaceInstructions = `
<h2>Starting work at Northbank Services</h2>
<h3>Your first week</h3>
<p>On your first morning, arrive at reception at 08:45 and show your photo identification. Reception will give you a temporary pass and ask you to check the spelling of your name for the permanent card. The temporary pass opens the reception area and staff cafeteria only. Your manager will meet you at 09:00 and take you to your desk. If your journey is delayed, telephone reception rather than your manager, who may already be in a meeting.</p>
<p>You must complete the safety briefing before entering the workshop. This applies even if you have worked in a similar environment before. The briefing covers protective clothing, emergency exits and the outdoor assembly point. After the briefing, your team leader will provide a locker key and explain which equipment you are authorised to use. Do not borrow another employee's access card if your own card does not open a door; ask reception to check your permissions.</p>
<p>All induction activities take place during paid working hours. Your first week includes a group introduction, a practical demonstration and a meeting about your role. You will also be paired with a colleague who can answer everyday questions. This colleague is your workplace buddy, but your manager remains responsible for agreeing your duties. Keep a note of any questions that are not urgent and bring them to the meeting at the end of the week. If a question concerns immediate safety, stop the activity and ask for help straight away.</p>
<h3>Using a pool bicycle for a work journey</h3>
<p>Company bicycles are available for short work journeys from Monday to Friday. They are intended for destinations within five kilometres of the office and must not be taken home overnight. Make a reservation on the intranet before 16:00 on the previous working day. Enter your destination and expected return time so that other staff can plan their journeys. An email confirmation means that a bicycle has been reserved; a request shown as pending does not.</p>
<p>Collect the bicycle key from security. Helmets and reflective jackets are available there if you need them. Before leaving, check the tyres, brakes and bell. If you find damage, complete a defect form and hand it to security. Do not use the bicycle while waiting for someone to inspect it. Security will offer another bicycle if one is available; otherwise, speak to your manager about a different way to travel. Staff must not attempt repairs themselves, even if they normally maintain their own bicycles.</p>
<p>Return the bicycle to its numbered space and lock it securely. If you expect to be late, telephone reception so that the next user can be informed. A lost key must be reported to security immediately. In severe weather, your manager may cancel a bicycle journey and approve another means of transport. These arrangements are reviewed each quarter, and staff are invited to suggest changes through the travel page on the intranet.</p>`;

const longerText = `
<h2>A library of things learns to listen</h2>
<p><strong>A</strong> When an empty shop became available in the town of Merrow, the council invited residents to suggest a use for it. The first proposal was a showroom for environmentally friendly products. A group of residents offered a different idea: instead of displaying more things to buy, the shop could lend objects that people needed only occasionally. A carpet cleaner, a large cooking pot or a folding table could serve several households without belonging to any of them. The council agreed to fund a six-month trial. The volunteers called it the Borrowing Room, and they expected the main challenge to be persuading people that sharing equipment would save them money.</p>
<p><strong>B</strong> The opening weeks appeared successful. Many residents registered, and several popular objects were reserved almost continuously. Yet the volunteers noticed that a considerable number of reservations were never collected. They initially assumed that users had forgotten their bookings and sent more reminders. A short survey revealed a different problem. Collection was available only between ten and four on weekdays, when many residents were at work. Reminders could not solve that difficulty. Moving one collection session to the evening reduced the number of missed reservations, even though the total weekly opening hours stayed the same. The experience taught the team to examine the whole borrowing process rather than judge demand from registration numbers alone.</p>
<p><strong>C</strong> Practical convenience was not the only obstacle. Some residents associated owning tools with being capable and independent. Borrowing from a community project seemed to them like admitting that they could not manage their own homes. Rather than challenging those feelings directly, the volunteers invited experienced users to demonstrate how equipment worked. A person who borrowed a drill might later lead a short session on putting up a shelf. Gradually, skill became something that members could contribute, while ownership became less important. The organisers did not claim that everyone's attitude had changed. However, several people who had declined to join at first began attending demonstrations and eventually borrowed an item.</p>
<p><strong>D</strong> Donations created a further problem. Residents offered many more objects than the room could safely store or maintain. Accepting every donation would have made the catalogue look impressive, but it would also have increased inspection work. Some equipment required specialist knowledge, and new volunteers could not become competent simply by reading a leaflet. The team therefore limited the range of equipment to items its trained volunteers could check confidently. New categories were added only when an experienced person was available to supervise others. This policy disappointed some donors, but it reduced cancelled loans caused by faults discovered at the last moment. A smaller catalogue proved easier to keep reliable.</p>
<p><strong>E</strong> At the end of the trial, councillors wanted evidence of the project's environmental value. Counting loans was straightforward; calculating purchases avoided was more difficult. Someone might borrow a carpet cleaner instead of hiring one, or borrow a table for an event that would otherwise have used no table at all. The team asked members what they would probably have done without the service. These responses were useful, but they described intentions rather than actions that could be observed. The final report therefore presented a range of possible savings, not a single precise total. It also recorded the journeys needed to collect equipment and the materials used in repairs, acknowledging that sharing itself required resources.</p>
<p><strong>F</strong> The council renewed the lease, but the project did not immediately expand into a larger building. The volunteers chose to improve booking information, publish dependable collection times and train more people to inspect the existing stock. They believed these changes would make the service more useful than a rapid increase in the number of objects on the shelves. Other towns later asked for a copy of the catalogue. The organisers shared it, while pointing out that local working hours, transport and practical skills would shape a service's needs. Their central lesson was that a lending project succeeds by understanding the people around it, not merely by accumulating useful things.</p>`;

const letter = (id, title, register, scenario, recipient, bullets, greeting) =>
  item(
    id,
    "writing",
    title,
    `Task 1 · ${register === "formal" ? "正式书信" : register === "semi-formal" ? "半正式书信" : "非正式书信"} · 建议20分钟，至少150词。`,
    {
      writingPart: 1,
      writingTitle: title,
      writingGenre: "letter",
      letterRegister: register,
      minimumWords: 150,
      recommendedMinutes: 20,
      hasSample: false,
      writingQuestion: `<p><strong>Original practice · General Training Writing Task 1</strong></p><p>Allow about 20 minutes for this task.</p><p>${scenario}</p><p>Write a letter to ${recipient}. In your letter:</p><ul>${bullets.map((point) => `<li>${point}</li>`).join("")}</ul><p>Write at least 150 words. You do not need to include postal addresses.</p><p>Begin your letter: <strong>${greeting}</strong></p>`,
      writingQuestionText: `${scenario} Write a letter to ${recipient}: ${bullets.join("; ")}. Write at least 150 words.`,
    },
  );

export const generalTrainingItems = [
  item(
    "general-reading-section-1",
    "reading",
    "Community notices · 日常告示",
    "Section 1 · 四则日常告示 · 匹配与填空，共6题。",
    {
      part: 1,
      passagesContent: everydayNotices,
      questions: [
        group(
          "general-s1-match",
          4,
          1,
          "Which notice contains the following information? Choose A, B, C or D. You may use a letter more than once.",
          {
            questionsContent:
              "<p>1. You need evidence of where you live before you can borrow equipment. ......</p><p>2. Visitors may attend without making a booking. ......</p><p>3. You can recover the whole fee if you cancel early enough. ......</p>",
            matchOptions: [
              "Tool Library",
              "Cooking workshop",
              "Repair afternoon",
              "Garden exchange",
            ].map((content, i) => ({ index: "ABCD"[i], content })),
          },
          [
            solution(
              0,
              "A要求带上显示家庭地址的近期账单，才能注册借用工具。",
              "To join, bring photo identification and a recent bill showing your home address to the library desk.",
            ),
            solution(
              2,
              "C明确写明不需要预约，按到达顺序接待。",
              "No appointment is needed: visitors are seen in order of arrival.",
            ),
            solution(
              1,
              "B规定至少提前三天取消可获得全额退款。",
              "If you cancel at least three days before the workshop, we will return your payment in full.",
            ),
          ],
        ),
        group(
          "general-s1-gaps",
          0,
          4,
          "Complete the notes. Use ONE WORD AND/OR A NUMBER from the notices for each answer.",
          {
            questionsContent:
              "<h3>Useful details</h3><p>4. A normal tool loan can last up to ...... days.</p><p>5. Cooking participants need to bring an ...... .</p><p>6. Donated seeds belong in the ...... box.</p>",
          },
          [
            solution(
              "seven/7",
              "A的借用期限为七天，seven和7均可。",
              "You may borrow two items at a time for up to seven days.",
            ),
            solution(
              "apron",
              "B提供食材和器材，但要求参与者带围裙。",
              "Ingredients and cooking equipment are included in the £18 fee, but participants should bring an apron.",
            ),
            solution(
              "green",
              "D指定种子放在绿色盒子中；幼苗才放在桌上。",
              "Leave donated seeds in the green box and label them with the plant name and the year they were collected.",
            ),
          ],
        ),
      ],
    },
    6,
  ),
  item(
    "general-reading-section-2",
    "reading",
    "Starting work · 职场指引",
    "Section 2 · 入职与公司自行车使用说明 · 判断与填空，共6题。",
    {
      part: 2,
      passagesContent: workplaceInstructions,
      questions: [
        group(
          "general-s2-judgement",
          3,
          1,
          "Do the statements agree with the information in the text? Choose TRUE, FALSE or NOT GIVEN.",
          {
            questions: [
              "New employees may enter the workshop before completing their safety briefing.",
              "Employees are paid for the time they spend on induction activities.",
              "Every workplace buddy joined the company during the previous year.",
            ].map((content) => choice(content, ["TRUE", "FALSE", "NOT GIVEN"])),
          },
          [
            solution(
              1,
              "文章明确要求先完成安全简报才能进入工作间，与题干相反。",
              "You must complete the safety briefing before entering the workshop.",
            ),
            solution(
              0,
              "所有入职活动都在带薪工作时间内进行，因此为TRUE。",
              "All induction activities take place during paid working hours.",
            ),
            solution(
              2,
              "文章介绍了buddy的职责，但未说明他们加入公司的时间，无法判断是否都在上一年入职。",
            ),
          ],
        ),
        group(
          "general-s2-gaps",
          0,
          4,
          "Complete the instructions. Use ONE WORD from the text for each answer.",
          {
            questionsContent:
              "<h3>Pool bicycle checklist</h3><p>4. Make your booking on the ...... before the stated deadline.</p><p>5. If a bicycle is damaged, fill in a ...... form before leaving.</p><p>6. Report a missing bicycle key to ...... immediately.</p>",
          },
          [
            solution(
              "intranet",
              "预约须在前一工作日下午16点前通过公司内网完成。",
              "Make a reservation on the intranet before 16:00 on the previous working day.",
            ),
            solution(
              "defect",
              "发现损坏时填写defect form，不应自行维修或继续使用。",
              "If you find damage, complete a defect form and hand it to security.",
            ),
            solution(
              "security",
              "钥匙遗失须向security报告；预计迟还才联系reception。",
              "A lost key must be reported to security immediately.",
            ),
          ],
        ),
      ],
    },
    6,
  ),
  item(
    "general-reading-section-3",
    "reading",
    "A library of things · 长篇阅读",
    "Section 3 · 社区物品借用项目 · 单选与段落信息匹配，共6题。",
    {
      part: 3,
      passagesContent: longerText,
      questions: [
        group(
          "general-s3-choice",
          1,
          1,
          "Choose the correct answer, A, B, C or D.",
          {
            questions: [
              choice(
                "Why did the Borrowing Room introduce an evening collection session?",
                [
                  "To increase the number of weekly opening hours",
                  "To help people whose jobs prevented daytime collection",
                  "To reduce the cost of sending booking reminders",
                  "To create space for more equipment demonstrations",
                ],
              ),
              choice(
                "Why did the team restrict the kinds of equipment it accepted?",
                [
                  "The council allowed only objects donated by residents",
                  "Members preferred new equipment to donated objects",
                  "The team needed enough expertise to inspect the equipment safely",
                  "The most popular objects were too expensive to insure",
                ],
              ),
              choice(
                "What limitation did the team recognise in its environmental evaluation?",
                [
                  "Members' descriptions of alternative actions could not be directly verified",
                  "No records had been kept of the number of loans",
                  "Transport had a greater environmental cost than manufacturing",
                  "It was impossible to ask members about their purchasing decisions",
                ],
              ),
            ],
          },
          [
            solution(
              1,
              "B段调查发现取物时段与工作时间冲突，因此增加晚间取物；每周总开放时长并未增加。",
              "Collection was available only between ten and four on weekdays, when many residents were at work.",
            ),
            solution(
              2,
              "D段限制品类是为了确保经过培训的志愿者能有把握地检查器材。",
              "The team therefore limited the range of equipment to items its trained volunteers could check confidently.",
            ),
            solution(
              0,
              "E段说明借用者说的是假设意愿，而非可观察核实的实际行为，因此给出区间估计。",
              "These responses were useful, but they described intentions rather than actions that could be observed.",
            ),
          ],
        ),
        group(
          "general-s3-match",
          4,
          4,
          "Which paragraph contains the following information? Choose A–F. You may use a letter more than once.",
          {
            questionsContent:
              "<p>4. A belief that possessing tools is a sign of personal independence ......</p><p>5. An earlier proposal to use the empty shop for a different purpose ......</p><p>6. A decision to improve the existing service before making it larger ......</p>",
            matchOptions: [..."ABCDEF"].map((index) => ({
              index,
              content: `Paragraph ${index}`,
            })),
          },
          [
            solution(
              2,
              "C段说明一些居民将拥有工具与能力和独立性联系起来。",
              "Some residents associated owning tools with being capable and independent.",
            ),
            solution(
              0,
              "A段介绍最早的建议是将空店面用作环保产品展示厅。",
              "The first proposal was a showroom for environmentally friendly products.",
            ),
            solution(
              5,
              "F段说明团队暂不扩张，先改善预订信息、开放时间和检查能力。",
              "The volunteers chose to improve booking information, publish dependable collection times and train more people to inspect the existing stock.",
            ),
          ],
        ),
      ],
    },
    6,
  ),
  letter(
    "general-writing-task-1-formal",
    "A cancelled room booking · 正式书信",
    "formal",
    "You booked a room at a community centre for an important event. Shortly before the event, the centre informed you that the room would not be available. You have not met the centre manager before.",
    "the community centre manager",
    [
      "describe the event and the booking you made",
      "explain how the cancellation affects your plans",
      "say what you would like the manager to do",
    ],
    "Dear Sir or Madam,",
  ),
  letter(
    "general-writing-task-1-semi-formal",
    "A temporary change of hours · 半正式书信",
    "semi-formal",
    "You work in a small company and know your manager, Ms Patel, well. You need to change your working hours temporarily because you have enrolled on a short evening course.",
    "Ms Patel",
    [
      "explain what the course is and why you want to attend it",
      "describe the temporary change to your hours that you need",
      "suggest how you will make sure your work is completed",
    ],
    "Dear Ms Patel,",
  ),
  letter(
    "general-writing-task-1-informal",
    "Looking after your home · 非正式书信",
    "informal",
    "Your friend Sam has offered to look after your home while you are away for a week. You would like to accept the offer and give your friend some useful information.",
    "Sam",
    [
      "thank your friend and explain when you will be away",
      "describe the things you would like your friend to do",
      "suggest a way to thank your friend after you return",
    ],
    "Dear Sam,",
  ),
  item(
    "general-writing-task-2-community",
    "writing",
    "Supporting local communities · 议论文",
    "Task 2 · 讨论双方观点并表达立场 · 建议40分钟，至少250词。",
    {
      writingPart: 2,
      writingTitle: "Supporting local communities",
      writingGenre: "essay",
      minimumWords: 250,
      recommendedMinutes: 40,
      hasSample: false,
      writingQuestion:
        "<p><strong>Original practice · General Training Writing Task 2</strong></p><p>Allow about 40 minutes for this task.</p><p>Some people think employers should give staff paid time to take part in projects that help the local community. Others believe employees should do this only in their own free time.</p><p>Discuss both views and give your own opinion. Support your ideas with reasons and relevant examples from your knowledge or experience.</p><p>Write at least 250 words.</p>",
      writingQuestionText:
        "Should employers provide paid time for staff to help their local community, or should employees volunteer only in their own free time? Discuss both views and give your own opinion. Write at least 250 words.",
    },
  ),
];
