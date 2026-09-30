/**
 * Regression cases for the auto-answer question detector, collected from real
 * interviews replayed through the app (see README.md). Each line is judged the
 * way the detector judges a transcribed line: split into sentences, keep the
 * questions, and answer unless every question is small talk.
 *
 *   npm run test:detector
 */
import { isSmallTalk, looksLikeQuestion } from "@/lib/functions/question-detect.function";

/** Real questions a candidate would want help with. */
const ANSWER = [
  // Synthetic meetings and the test clip
  "Can you walk me through how your product handles rate limiting for our public API?",
  "What would the total cost look like for two hundred users?",
  "How would you behave if an entire region went down? Like, what happens to requests that are already in flight?",
  "And do you support single sign on with Okta?",
  "Tell me about a customer similar to us and what results they saw.",
  "Could you send us a pricing proposal by Friday?",
  "Are you familiar with consistent hashing?",
  "Is this approach scalable?",
  "How are you handling authentication today?",
  "Can you see any issues with this code?",
  "Do you see a problem with this query?",
  "How is your team structured?",
  "Is this the right data structure for the job?",
  "Why don't you walk me through your design?",
  "Can you hear the difference between these two approaches?",
  "Does that approach work at scale?",
  "What's the time complexity of your solution?",
  "Do you have experience with Kafka?",
  "Is it possible to do this in O(n)?",
  "Are you ready to talk about system design, or should we start with coding?",
  "How would you test this?",
  "Is this Kubernetes cluster multi-region?",
  // Hesitations before a question, and a dropped "?"
  "MM-M, interesting, why a lock-free ring buffer instead of a regular Q",
  "Mmm, interesting, why a lock free ring buffer instead of a queue",
  "Hmm, okay, how would you handle retries here",
  "Uh-huh, and what happens when the cache is cold",
  "Um, so what's your approach for this one",
  "How would you scale this service to ten times the traffic",
  // Real interviews
  "Why did you change it from starting amount?",
  "Can you give me an example of what that?",
  "Yep, and so what are you proposing changing here?",
  "What is unit to check?",
  "Do you have any thoughts on how we might be able to kind of like...",
  "What do you mean by graph?",
  "What do you think?",
  "Do you have any questions about the constraints before you start coding?",
  "So, what are the conditions for the parenthesis to be well formed? And then let's discuss that.",
  "Why is it not valid? What is the condition that is being false over here?",
  "Yeah, so what will be their time and this space conflict?",
  "Do you think we can optimize this?",
  "No, okay. So, what is the time complexity now?",
  "Can you think of any edge case and dryer and for that maybe this feasible quote like the possible quote?",
  "Just a question, what do you mean by optimal allocation of pages?",
  "Walk me through maybe like if you want, you know with this example walk me through how exactly you would do it",
  "Well, is there a reason that you would prefer using one map over two maps or no?",
  "What is the difference between service ID and service type?",
  // "I" in a side clause, still asking you
  "Now, when I have to fill this second one, what happens?",
  "So if I go like this, in this case what happens?",
  "I mean, you know, what would you do in a production database?",
  "Okay, so given this graph, how do you find the number of components?",
  "Right, and in that case, how would you make sure there are no cycles?",
  "Is the time complexity of this approach correct?",
  "Is my understanding of the problem statement right?",
];

/** Lines that shouldn't cost an AI request. */
const SKIP = [
  // Small talk and logistics
  "How are you?",
  "Hey, how are you doing today?",
  "Is this Nolan?",
  "Am I speaking with Grace Lee?",
  "Can you hear me okay?",
  "Can you see my screen?",
  "Is now still a good time for you?",
  "Are you ready?",
  "Shall we get started?",
  "Does that make sense?",
  "Any questions so far?",
  "So why don't I go ahead and share my screen?",
  "Did you get the link I sent?",
  "Can you just type something so I can see it?",
  "Do you see the editor?",
  "How was your weekend?",
  "Are you still there?",
  "Sounds good?",
  "Is my audio okay?",
  "Hey, my name is Grace, I'm calling from Jane Street, is this Nolan?",
  // Check-ins that are really statements (Jane Street)
  "But otherwise, do you have any questions?",
  "And I guess you probably want to make that and actually use the edge class there, right?",
  "running product of these conversion rates, does it?",
  "Two convergent rates, right?",
  "what that conversion rate is. Does that sound right to you?",
  "Is that what you were thinking?",
  "Like a what?",
  "how to effectively keep track of like.",
  'So when you practice, instead of just looking at the solution saying, "Yeah, I could have gotten that."',
  // Fillers that aren't questions
  "Mm-hmm.",
  "Hmm, that makes sense.",
  "Okay, let's move to a coding question, given an array of integers.",
  "Uh, I think we could use a heap.",
  // Thinking aloud (first person)
  "Can I add opening parenthesis?",
  "So, what I do? So, basically,",
  "What is my condition right now? S is equal to 1.",
  "But how am I making sure?",
  "Anything I can do? Should I do good?",
  "Okay, should I write the code for this? Wait, okay.",
  // Thinking aloud after a comma (Striver interview, found in the held-out check)
  "Now, this is where to start thinking, how do I make sure that I do this?",
  "Now this is where I have to start thinking, how do I make sure that I remove?",
  "How many more do I require? The more requirement was to if I am not wrong correct?",
  "and that came up as current component. And how much more do I require?",
  "which groups do I belong to?",
  "I'll just describe the API also, but is this part fine or should I dig deeper into this?",
  // Too short to be worth answering (mostly mishearing)
  "So what to me?",
  "How's the thieves?",
  "it even more?",
  "have you heard?",
  "What is reserved?",
  // Following along and what's next
  "Did you get the question?",
  "Did you understand what I'm saying? Am I making sense to you?",
  "I lost you but can you repeat that?",
  "Yeah, can you repeat now?",
  "So, should we do one more question?",
  "Since we have time, do you mind doing this? It will be something interesting for our audience.",
  "Yeah, anything else?",
  "Which language are you gonna code?",
  // After the interview
  "How was your experience? Giving a mock interview on YouTube takes a lot of courage.",
  "Yeah, so you tell me your experience first, how was it?",
  "So how do you think I was?",
  "I'm going to stop the timer. So first of all, how do you feel about this?",
];

const wouldAnswer = (line: string) => {
  const questions = line.split(/(?<=[.?!])\s+/).filter(looksLikeQuestion);
  return questions.length > 0 && !questions.every(isSmallTalk);
};

const failures = [
  ...ANSWER.filter((q) => !wouldAnswer(q)).map((q) => `should answer: ${q}`),
  ...SKIP.filter(wouldAnswer).map((q) => `should skip:   ${q}`),
];
if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\n${failures.length} of ${ANSWER.length + SKIP.length} cases failed`);
  process.exit(1);
}
console.log(`all ${ANSWER.length + SKIP.length} detector cases pass`);
