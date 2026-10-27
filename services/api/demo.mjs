// All demonstration texts are original. No archived or third-party lesson content is bundled.
const audio = "/media/demo-listening.wav";
const base = (kind, title, data, extra = {}) => ({
  id: `demo-${kind}`,
  kind,
  title,
  collection: "原创体验课",
  count: 1,
  data,
  localMedia: {},
  ...extra,
});
const listeningLines = [
  {
    startTime: 0,
    endTime: 5143,
    englishDetail:
      "Welcome to the Riverside learning centre. The new conversation club meets on Monday.",
    translateDetail: "欢迎来到河畔学习中心。新的会话俱乐部每周一见面。",
  },
  {
    startTime: 5143,
    endTime: 9260,
    englishDetail:
      "Please bring a notebook. The monthly membership costs twenty pounds.",
    translateDetail: "请带一本笔记本。月度会员费用为二十英镑。",
  },
  {
    startTime: 9260,
    endTime: 13237,
    englishDetail:
      "Our first meeting will take place in the library, next to the garden.",
    translateDetail: "第一次活动在花园旁的图书馆举行。",
  },
  {
    startTime: 13237,
    endTime: 17476,
    englishDetail:
      "You can register by email. There is no need to telephone the office.",
    translateDetail: "你可以通过电子邮件报名，无需致电办公室。",
  },
];
const gap = (answers, html) => ({
  questionId: "demo-fill",
  questionCount: answers.length,
  firstQuestionType: 0,
  questionType: 0,
  questionJson: {
    questionType: "0",
    startIndex: 1,
    endIndex: answers.length,
    questionNum: answers.length,
    descriptions: "Write ONE WORD AND/OR A NUMBER for each answer.",
    questionsContent: html,
  },
  answerJson: answers.map(([correctValue, explain], i) => ({
    correctValue,
    explain,
    sentenceList: [i],
    positionSentence: listeningLines[i]?.englishDetail || "",
  })),
});
const vocabularyWords = [
  {
    headWord: "curiosity",
    ukPhone: "ˌkjʊəriˈɒsəti",
    usPhone: "ˌkjʊriˈɑːsəti",
    translations: [{ pos: "n.", tranCn: "好奇心", translation: "好奇心" }],
    examples: [
      {
        en: "Curiosity helps us notice a question before we look for an answer.",
        cn: "好奇心让我们先发现问题，再寻找答案。",
      },
    ],
  },
  {
    headWord: "evidence",
    ukPhone: "ˈevɪdəns",
    usPhone: "ˈevɪdəns",
    translations: [{ pos: "n.", tranCn: "证据", translation: "证据" }],
    examples: [
      {
        en: "A useful argument connects a claim with clear evidence.",
        cn: "好的论证将主张与清晰的证据联系起来。",
      },
    ],
  },
  {
    headWord: "adapt",
    ukPhone: "əˈdæpt",
    usPhone: "əˈdæpt",
    translations: [
      { pos: "v.", tranCn: "适应；调整", translation: "适应；调整" },
    ],
    examples: [
      {
        en: "We adapt our study plan when we discover a better method.",
        cn: "发现更好的方法时，我们会调整学习计划。",
      },
    ],
  },
  {
    headWord: "consistent",
    ukPhone: "kənˈsɪstənt",
    usPhone: "kənˈsɪstənt",
    translations: [
      { pos: "adj.", tranCn: "持续的；一致的", translation: "持续的；一致的" },
    ],
    examples: [
      {
        en: "Small, consistent efforts make difficult tasks easier.",
        cn: "持续的小步努力让困难的任务变得容易。",
      },
    ],
  },
].map((word, index) => ({
  ...word,
  wordId: `demo-word-${index}`,
  id: index,
  audioUrls: { af_heart: `/media/demo-word-${index}.wav` },
}));
const sentences = [
  {
    sentenceId: "demo-s1",
    audioUrls: { af_heart: "/media/demo-sentence-0.wav" },
    sentenceText:
      "Although the experiment was small, its results encouraged the team to continue.",
    chinese: "尽管实验规模很小，其结果仍鼓励团队继续。",
    essayTitle: "Learning through experiments",
  },
  {
    sentenceId: "demo-s2",
    audioUrls: { af_heart: "/media/demo-sentence-1.wav" },
    sentenceText:
      "The park, which had been empty for years, became a meeting place for local residents.",
    chinese: "这座多年来空置的公园成为当地居民的聚会场所。",
    essayTitle: "Shared spaces",
  },
  {
    sentenceId: "demo-s3",
    audioUrls: { af_heart: "/media/demo-sentence-2.wav" },
    sentenceText:
      "By recording what they notice each day, learners can make their progress visible.",
    chinese: "通过每天记录自己的发现，学习者可以让进步变得可见。",
    essayTitle: "Visible progress",
  },
];
export const demoItems = [
  base(
    "listening",
    "Riverside learning centre · 听力体验",
    {
      audioUrl: audio,
      seconds: 17.476,
      part: 1,
      listenQuestion: "<h3>Conversation club registration</h3>",
      listenContent: listeningLines.map((row) => row.englishDetail).join(" "),
      listenDetail: listeningLines
        .map(
          (row) =>
            `[${String(Math.floor(row.startTime / 60000)).padStart(2, "0")}:${((row.startTime / 1000) % 60).toFixed(2).padStart(5, "0")}]${row.englishDetail}##${row.translateDetail}`,
        )
        .join("\n"),
      subjectData: { listenDetailList: listeningLines },
      questions: [
        gap(
          [
            ["Monday", "活动在周一举行。"],
            ["20", "每月费用为 twenty pounds，即20英镑。"],
            ["library", "活动地点是图书馆。"],
            ["email", "报名使用电子邮件。"],
          ],
          "<p>1. Meeting day: ......</p><p>2. Monthly cost: £ ......</p><p>3. Meeting place: the ......</p><p>4. Register by: ......</p>",
        ),
      ],
    },
    { count: 4, description: "原创短对话，体验答题、判分和精听。" },
  ),
  base(
    "reading",
    "The value of small experiments · 阅读体验",
    {
      part: 1,
      passagesContent:
        "<h2>The value of small experiments</h2><p><strong>A</strong> A neighbourhood library wanted to help more adults read regularly. Instead of rebuilding its entire programme, it began a four-week experiment. A small table near the entrance displayed five short books, and visitors could borrow one without attending an event.</p><p><strong>B</strong> Staff counted how often the books were borrowed and invited readers to leave a short comment. They discovered that clear descriptions mattered more than colourful covers. Several readers said that knowing a book could be finished in one evening made it easier to begin.</p><p><strong>C</strong> The library then changed the descriptions and repeated the experiment. Borrowing increased, but staff did not claim that one change would work everywhere. They shared their method with other libraries so that each could test it in its own community.</p>",
      articleTranslation:
        "<p>一个社区图书馆通过为期四周的小实验，探索如何帮助成年人规律阅读。工作人员发现，清晰的介绍比鲜艳的封面更重要。他们分享实验方法，让其他社区自行检验。</p>",
      questions: [
        {
          questionId: "demo-reading-judgement",
          questionType: 3,
          questionCount: 4,
          questionJson: {
            questionType: "3",
            startIndex: 1,
            endIndex: 4,
            questionNum: 4,
            descriptions:
              "Do the statements agree with the passage? Choose TRUE, FALSE or NOT GIVEN.",
            questions: [
              { number: 1, content: "The first experiment lasted four weeks." },
              {
                number: 2,
                content:
                  "Visitors had to attend an event before borrowing a book.",
              },
              {
                number: 3,
                content: "The library bought its books from a local shop.",
              },
              {
                number: 4,
                content:
                  "The staff encouraged other libraries to test the method themselves.",
              },
            ].map((question) => ({
              ...question,
              options: [
                { content: "TRUE" },
                { content: "FALSE" },
                { content: "NOT GIVEN" },
              ],
            })),
          },
          answerJson: [
            { correctValue: 0, explain: "A段明确说明实验持续四周。" },
            { correctValue: 1, explain: "A段说明借书不必参加活动。" },
            { correctValue: 2, explain: "文章没有说明书籍的采购地点。" },
            { correctValue: 0, explain: "C段说明每个社区可以自行检验方法。" },
          ],
        },
      ],
    },
    { count: 4 },
  ),
  base("writing", "Libraries in a digital age · 写作体验", {
    writingPart: 2,
    hasSample: false,
    writingTitle: "Public libraries",
    writingQuestion:
      "<p>Some people believe that public libraries should focus on digital services. Others think that physical books and shared spaces remain essential.</p><p>Discuss both views and give your own opinion. Give reasons and examples.</p><p>Write at least 250 words.</p>",
    writingQuestionText:
      "Discuss digital services and physical spaces in public libraries.",
  }),
  base(
    "speaking",
    "A place where you learn · 口语体验",
    {
      questionType: 1,
      oralQuestionDetailVOList: [
        {
          oralPart: 1,
          oralQuestionId: 1,
          oralQuestion:
            "Where do you usually study, and why do you choose that place?",
          questionOralList: [
            { typeStr: "原创题目朗读", oralUrl: "/media/demo-speaking-0.wav" },
          ],
        },
        {
          oralPart: 2,
          oralQuestionId: 2,
          oralQuestion:
            "Describe a place where you learned something useful. You should say where it was, what you learned, who helped you, and explain why the experience matters to you.",
          questionOralList: [
            { typeStr: "原创题目朗读", oralUrl: "/media/demo-speaking-1.wav" },
          ],
        },
        {
          oralPart: 3,
          oralQuestionId: 3,
          oralQuestion:
            "How can cities create more opportunities for adults to keep learning?",
          questionOralList: [
            { typeStr: "原创题目朗读", oralUrl: "/media/demo-speaking-2.wav" },
          ],
        },
      ],
    },
    { count: 3 },
  ),
  base(
    "vocabulary",
    "Learning habits · 词汇体验",
    {
      declaredCollection: { title: "Learning habits" },
      items: vocabularyWords,
    },
    { count: 4 },
  ),
  base(
    "sentences",
    "Making progress · 句子体验",
    { declaredCollection: { title: "Making progress" }, items: sentences },
    { count: 3 },
  ),
  base(
    "grammar",
    "让步从句与定语从句 · 语法体验",
    {
      sentences: sentences.slice(0, 2).map((sentence, index) => ({
        ...sentence,
        grammarTags: {
          chinese: sentence.chinese,
          clauseStructure: {
            structure: {
              主句: index
                ? "The park became a meeting place for local residents."
                : "Its results encouraged the team to continue.",
              从句: [
                index
                  ? "which had been empty for years"
                  : "Although the experiment was small",
              ],
              语法提示: index
                ? "which 引导非限定性定语从句，补充说明 park。"
                : "although 引导让步状语从句。",
            },
          },
          words: [
            {
              word: index ? "which" : "Although",
              posLabel: "连接词",
              chinese: index
                ? "关系代词，引导非限定性定语从句"
                : "尽管，引导让步状语从句",
            },
            {
              word: index ? "became" : "encouraged",
              posLabel: "动词",
              chinese: index ? "成为，过去式" : "鼓励，过去式",
            },
          ],
        },
      })),
    },
    { count: 2 },
  ),
  base(
    "numbers",
    "Numbers in everyday life · 数字听写体验",
    {
      groupNo: 1,
      items: [
        {
          id: 1,
          itemNo: 1,
          answerText: "20",
          category: "价格",
          audioUrl: "/media/demo-number.wav",
        },
        {
          id: 2,
          itemNo: 2,
          answerText: "20",
          category: "数量",
          audioUrl: "/media/demo-number.wav",
        },
      ],
    },
    { count: 2 },
  ),
  base("typing", "A little progress every day · 打字体验", {
    title: "A little progress every day",
    content:
      "Learning becomes easier when we give it a regular place in our day. A short session can be enough to notice a new word, ask a useful question, or improve one sentence. Progress is not always dramatic. Sometimes it is simply the decision to return tomorrow with curiosity.",
    类别: "原创学习随笔",
  }),
  base("courses", "Build your own study routine · 课程体验", {
    title: "Build your own study routine",
    durationSeconds: 21.2,
    attachments: [
      { kind: "video", url: "/media/demo-course.mp4" },
      { kind: "audio", url: "/media/demo-listening.wav" },
    ],
    slidesMetadata: [
      {
        name: "三个步骤",
        page_list: [{ url: "/media/demo-slide.svg", width: 1280, height: 720 }],
      },
    ],
    description:
      "这是一份原创课件示例。导入已有归档后，可在此查看课程视频、音频和课件图片。",
  }),
];

const demoReading = demoItems.find((item) => item.kind === "reading");
demoReading.data.questions.push(
  {
    questionId: "demo-choice",
    questionType: 1,
    questionCount: 1,
    questionJson: {
      questionType: "1",
      startIndex: 5,
      endIndex: 5,
      questionNum: 1,
      descriptions: "Choose the correct letter, A, B or C.",
      questions: [
        {
          number: 1,
          content: "What made it easier for some readers to begin a book?",
          options: [
            { content: "Knowing that it could be finished in one evening." },
            { content: "Seeing a colourful cover." },
            { content: "Meeting the author at a library event." },
          ],
        },
      ],
    },
    answerJson: [
      {
        correctValue: 0,
        explain: "B段指出，知道一本书可以在一晚读完让读者更容易开始。",
      },
    ],
  },
  {
    questionId: "demo-multiple",
    questionType: 2,
    questionCount: 2,
    questionJson: {
      questionType: "2",
      startIndex: 6,
      endIndex: 7,
      questionNum: 2,
      descriptions: "Choose TWO letters, A–D.",
      questions: [
        {
          number: 2,
          content: "Which TWO actions did the library staff take?",
          options: [
            { content: "They counted how often the books were borrowed." },
            { content: "They invited readers to leave short comments." },
            { content: "They required every visitor to attend an event." },
            {
              content: "They claimed their findings would work in every city.",
            },
          ],
        },
      ],
    },
    answerJson: [
      {
        correctValue: [0, 1],
        explain: "B段分别提到了统计借阅次数以及收集简短评论。",
      },
    ],
  },
  {
    questionId: "demo-matching",
    questionType: 4,
    questionCount: 2,
    questionJson: {
      questionType: "4",
      startIndex: 8,
      endIndex: 9,
      questionNum: 2,
      descriptions: "Match each statement with the correct paragraph.",
      questionsContent:
        "<p>8. The original design of the experiment ......</p><p>9. Sharing the method with other communities ......</p>",
      matchOptions: [
        { index: "A", content: "Paragraph A" },
        { index: "B", content: "Paragraph B" },
        { index: "C", content: "Paragraph C" },
      ],
    },
    answerJson: [
      { correctValue: 0, explain: "A段介绍了最初实验的安排。" },
      { correctValue: 2, explain: "C段介绍了分享方法并鼓励各社区自行检验。" },
    ],
  },
);
demoReading.count = 9;
