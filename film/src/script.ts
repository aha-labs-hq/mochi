import type { Run } from "./lib/Chat.tsx";

/* The film's words, which both cuts share, in every language the film is cut
   in. zh-hans is the original; each other language is written in the same
   quiet voice, not word for word, and keeps the verse's echoes (the second
   and fourth lines answer each other). Names stay as they are everywhere. */

export const languages = ["zh-hans", "zh-hant", "en", "ja", "ko"] as const;
export type Language = (typeof languages)[number];

export type Words = {
  /** The verse, line by line. */
  verse: { findTheRightPerson: string; nobodyFollowsUp: string; explainAgain: string; someoneFollowsUp: string; waiting: string };
  /** Nora's question, late at night. */
  question: string;
  /** Mochi's answer, with the words that are sources, and the record it cites. */
  answer: Run[];
  answerSource: { kind: string; title: string; state: string };
  noraReplies: string;
  /** The next morning: decided in the group, picked up without a meeting. */
  morning: { jules: string; mochi: Run[]; evan: string };
  /** What each person does, beside their name in the group; Mochi has its name only. */
  roles: { nora: string; jules: string; evan: string; riley: string };
  mochi: string;
  /** The composer's button. */
  send: string;
  /** The end card: the product's name and what it is. */
  product: { name: string; line: string };
};

export const words: Record<Language, Words> = {
  "zh-hans": {
    verse: {
      findTheRightPerson: "问一句，要先找对人。",
      nobodyFollowsUp: "聊完了，没人接着做。",
      explainAgain: "问进展，又得从头讲一遍。",
      someoneFollowsUp: "聊定的事，有人接着做。",
      waiting: "我在群里等你。",
    },
    question: "周五的五家客户约好了。@所有人 邀请能写「不用注册，点开就能看」了吗？",
    answer: ["能，", { source: "已经上线" }, "了。写「公开链接，不用注册就能看」吧。私密内容和留言还是要登录，跟", { source: "之前定的" }, "一样。"],
    answerSource: { kind: "PR #101", title: "查看页已随 v1.8.0 发布", state: "已合并 · 已发布" },
    noraReplies: "好，那我发了。",
    morning: {
      jules: "行，就这么改。@麻薯 派给 Evan，这次先把查看做好。",
      mochi: [{ source: "#86" }, " 更新好了，已派给 Evan。"],
      evan: "收到，我来。",
    },
    roles: { nora: "运营", jules: "产品", evan: "研发", riley: "负责人" },
    mochi: "麻薯",
    send: "发送",
    product: { name: "Mochi 麻薯", line: "住在飞书群里的项目伙伴" },
  },
  "zh-hant": {
    verse: {
      findTheRightPerson: "問一句，要先找對人。",
      nobodyFollowsUp: "聊完了，沒人接著做。",
      explainAgain: "問進度，又得從頭講一遍。",
      someoneFollowsUp: "聊定的事，有人接著做。",
      waiting: "我在群組裡等你。",
    },
    question: "週五的五家客戶約好了。@所有人 邀請能寫「不用註冊，點開就能看」了嗎？",
    answer: ["可以，", { source: "已經上線" }, "了。寫「公開連結，不用註冊就能看」吧。私密內容和留言還是要登入，跟", { source: "之前定的" }, "一樣。"],
    answerSource: { kind: "PR #101", title: "檢視頁已隨 v1.8.0 發布", state: "已合併 · 已發布" },
    noraReplies: "好，那我發了。",
    morning: {
      jules: "好，就這樣改。@麻薯 指派給 Evan，這次先把檢視做好。",
      mochi: [{ source: "#86" }, " 更新好了，已指派給 Evan。"],
      evan: "收到，我來。",
    },
    roles: { nora: "營運", jules: "產品", evan: "研發", riley: "負責人" },
    mochi: "麻薯",
    send: "傳送",
    product: { name: "Mochi 麻薯", line: "住在飛書群組裡的專案夥伴" },
  },
  en: {
    verse: {
      findTheRightPerson: "To ask one thing, first find the right person.",
      nobodyFollowsUp: "The talk ends. Nobody picks it up.",
      explainAgain: "Ask for an update, and explain it all again.",
      someoneFollowsUp: "What's settled, somebody picks up.",
      waiting: "I'll be waiting in the group.",
    },
    question: "All five clients are booked for Friday. @all Can the invite say “no sign-up, just open the link” yet?",
    answer: ["Yes, it's ", { source: "already live" }, ". Say “public link, no sign-up needed.” Private content and comments still need a login, ", { source: "as we agreed" }, "."],
    answerSource: { kind: "PR #101", title: "View page shipped in v1.8.0", state: "Merged · Released" },
    noraReplies: "Great, sending it now.",
    morning: {
      jules: "OK, let's do that. @Mochi give it to Evan. Viewing comes first this time.",
      mochi: [{ source: "#86" }, " is updated and assigned to Evan."],
      evan: "Got it, on it.",
    },
    roles: { nora: "Ops", jules: "Product", evan: "Engineering", riley: "Lead" },
    mochi: "Mochi",
    send: "Send",
    product: { name: "Mochi", line: "The project companion in your Feishu group" },
  },
  ja: {
    verse: {
      findTheRightPerson: "ひとつ聞くにも、まず人探し。",
      nobodyFollowsUp: "話して終わり。誰も引き取らない。",
      explainAgain: "進み具合を聞けば、また一から説明。",
      someoneFollowsUp: "決まったことは、誰かが引き取る。",
      waiting: "グループで待ってるね。",
    },
    question: "金曜の5社、アポ取れました。@全員 招待に「登録なしで、開けばすぐ見られる」って書いて大丈夫ですか？",
    answer: ["はい、", { source: "もうリリース済み" }, "です。「公開リンクなので登録不要」と書きましょう。非公開の内容とコメントは、", { source: "前に決めたとおり" }, "ログインが必要です。"],
    answerSource: { kind: "PR #101", title: "閲覧ページを v1.8.0 でリリース", state: "マージ済み · リリース済み" },
    noraReplies: "了解、じゃあ送ります。",
    morning: {
      jules: "よし、それでいこう。@Mochi Evan に振って。今回はまず閲覧をちゃんと。",
      mochi: [{ source: "#86" }, " を更新して、Evan に割り当てました。"],
      evan: "了解、やります。",
    },
    roles: { nora: "運営", jules: "プロダクト", evan: "開発", riley: "リーダー" },
    mochi: "Mochi",
    send: "送信",
    product: { name: "Mochi", line: "Feishu のグループに住む、プロジェクトの相棒" },
  },
  ko: {
    verse: {
      findTheRightPerson: "하나 물으려 해도, 사람부터 찾아야 한다.",
      nobodyFollowsUp: "얘기는 끝났는데, 이어받는 사람이 없다.",
      explainAgain: "진행 상황을 물으면, 또 처음부터 설명이다.",
      someoneFollowsUp: "정한 일은, 누군가 이어받는다.",
      waiting: "그룹에서 기다릴게.",
    },
    question: "금요일 고객사 다섯 곳 약속 잡았어요. @모두 초대장에 ‘가입 없이 열면 바로 볼 수 있다’고 써도 될까요?",
    answer: ["네, ", { source: "이미 배포됐어요" }, ". ‘공개 링크라 가입 없이 볼 수 있다’고 쓰세요. 비공개 내용과 댓글은 ", { source: "전에 정한 대로" }, " 로그인이 필요해요."],
    answerSource: { kind: "PR #101", title: "보기 페이지 v1.8.0에 배포", state: "병합됨 · 배포됨" },
    noraReplies: "좋아요, 그럼 보낼게요.",
    morning: {
      jules: "좋아요, 그렇게 바꾸죠. @Mochi Evan에게 맡겨 줘요. 이번엔 보기부터 제대로.",
      mochi: [{ source: "#86" }, " 업데이트하고 Evan에게 배정했어요."],
      evan: "네, 제가 할게요.",
    },
    roles: { nora: "운영", jules: "기획", evan: "개발", riley: "리더" },
    mochi: "Mochi",
    send: "전송",
    product: { name: "Mochi", line: "Feishu 그룹에 사는 프로젝트 동료" },
  },
};
