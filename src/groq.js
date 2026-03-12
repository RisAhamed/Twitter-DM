import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const MAX_RETRIES = 3;

export async function generateMessage({ name, bio, campaignContext, ctaLink, model }) {
  const useModel = model || DEFAULT_MODEL;

  const systemPrompt = `You are a friendly outreach copywriter. Write a casual, friendly 2-3 sentence Twitter DM.
Rules:
- Mention something specific from the recipient's bio to show genuine interest.
- Subtly pitch the following service: ${campaignContext}
- End the message by naturally sharing this link: ${ctaLink}
- Do NOT be overly formal or salesy.
- Do NOT use hashtags or emojis.
- Keep it under 500 characters.
- Return ONLY the DM text — no quotes, no preamble, no explanation.`;

  const userPrompt = `Recipient name: ${name || 'there'}\nRecipient bio: ${bio || 'No bio available'}`;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await groq.chat.completions.create({
        model: useModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.8,
        max_tokens: 300,
      });

      const text = response.choices?.[0]?.message?.content?.trim();
      if (text && text.length > 5) return text;

      lastError = new Error(`Groq returned empty/short message (attempt ${attempt}/${MAX_RETRIES})`);
      console.warn(`[Groq] Empty response on attempt ${attempt}, retrying...`);
      await new Promise(r => setTimeout(r, 1500 * attempt));
    } catch (err) {
      lastError = err;
      console.warn(`[Groq] API error on attempt ${attempt}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  throw lastError || new Error('Groq failed after all retries');
}
