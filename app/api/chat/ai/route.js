export const maxDuration = 60;
import connectDB from "@/config/db";
import Chat from "@/models/Chat";
import { getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { POST as webSearchHandler } from "../web/route";

const openai = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
});

export async function POST(req){
    try {
    const {userId} = getAuth(req)
    const { chatId, prompt, filesMeta = [], documentData = '', searchSelected, deepThinkSelected } = await req.json();
        if(!userId){
            return NextResponse.json({
                success: false,
                message: "User not authenticated",
            });
        }

        // Extract filenames from uploaded files
        const fileNames = Array.isArray(filesMeta) 
            ? filesMeta.map(f => f.originalName || f.fileName || f.name || 'Unknown')
            : [];

        await connectDB()
        const data = await Chat.findOne({userId, _id: chatId})

        // Use LLM with enhanced prompt to detect if user is referring to previous messages
        let isReferencingPrevious = false;
        const referenceClassifierPrompt = `You are a context classifier. Analyze if the user's message REQUIRES accessing previous chat history to provide a meaningful answer.

Message: "${prompt}"

Classify as YES ONLY if the message:
- Explicitly asks about previous messages ("what did I say", "earlier you mentioned", "continue from before")
- Asks about specific documents or files uploaded earlier ("the document I shared", "from the PDF", "summarize that file")
- Requires understanding prior discussion to answer ("elaborate on that", "more details about it", "explain that further")
- Uses pronouns that NEED previous context to understand ("what is it about?", "tell me more about that")
- Asks for summaries or comparisons with past topics ("difference from before", "how does this relate to what we discussed")

Classify as NO if the message:
- Is a polite acknowledgment or feedback ("thanks", "that was helpful", "excellent", "great", "awesome", "good job")
- Is a standalone, independent question with all context included
- Asks for general knowledge or current events
- Starts a completely new, unrelated topic
- Is a greeting or casual response ("hi", "hello", "ok", "sure", "I see")

Examples:
"What did I say before?" → YES
"Summarize the document I uploaded" → YES  
"Can you elaborate on that?" → YES (needs previous topic)
"Tell me more about AI" → NO (standalone topic)
"Thanks, that was excellent" → NO (just acknowledgment)
"Great, thank you!" → NO (just acknowledgment)
"What is the weather today?" → NO (standalone)
"Explain quantum computing" → NO (standalone)
"That's helpful" → NO (just feedback)

Answer ONLY: YES or NO`;
        const referenceClassifierResponse = await openai.chat.completions.create({
            messages: [{ role: "user", content: referenceClassifierPrompt }],
            model: "llama-3.3-70b-versatile",
            temperature: 0,
            max_tokens: 3,
        });
        isReferencingPrevious = referenceClassifierResponse.choices[0].message.content.trim().toUpperCase().includes('YES');
        console.log(`[AI Router] LLM Classification (refers to past): ${isReferencingPrevious}`);

        // Create user message object (but don't push yet)
        const userPrompt = {
            role: "user",
            content: prompt,
            timestamp: Date.now(),
            files: fileNames,
            hasFiles: fileNames.length > 0,
            documentData: documentData
        };

        // Concise web search logic
        let webResults = null;
        let userSelectedWebSearch = searchSelected ? 'YES' : 'NO';
        let usedWebSearch = 'NO';
        if (searchSelected) {
            const classifierPrompt = `Does this message require searching the web for an answer?\nMessage: "${prompt}"\nAnswer: YES or NO`;
            const response = await openai.chat.completions.create({
                messages: [{ role: "user", content: classifierPrompt }],
                model: "llama-3.3-70b-versatile",
                temperature: 0,
                max_tokens: 3,
            });
            if (response.choices[0].message.content.trim().toUpperCase().includes('YES')) {
                usedWebSearch = 'YES';
                try {
                    const mockReq = { json: async () => ({ query: prompt }) };
                    const webRes = await webSearchHandler(mockReq);
                    const webResData = await webRes.json();
                    if (webResData.success) {
                        webResults = {
                            answer: webResData.answer,
                            references: webResData.references
                        };
                    }
                } catch (err) {
                    console.log('Web search error:', err);
                }
            }
        }
        
        // Build intelligent context chain based on reference detection
        const allMessages = data.messages || [];
        let contextChain = '';
        if (isReferencingPrevious) {
            // Enhanced memory retrieval: Include both user messages AND assistant responses
            const recentConversation = allMessages.slice(-20); // Last 20 messages (10 exchanges)
            
            let conversationPairs = [];
            for (let i = 0; i < recentConversation.length; i += 2) {
                const userMsg = recentConversation[i];
                const assistantMsg = recentConversation[i + 1];
                
                if (userMsg && userMsg.role === 'user') {
                    const userContent = userMsg.content || '';
                    const userDoc = userMsg.documentData 
                        ? `\n[Document Content]: ${userMsg.documentData.substring(0, 1000)}${userMsg.documentData.length > 1000 ? '...' : ''}`
                        : '';
                    const userFiles = userMsg.files && userMsg.files.length > 0
                        ? `\n[Files]: ${userMsg.files.join(', ')}`
                        : '';
                    
                    const assistantContent = assistantMsg && assistantMsg.role === 'assistant'
                        ? assistantMsg.content.substring(0, 800) + (assistantMsg.content.length > 800 ? '...' : '')
                        : '[No response recorded]';
                    
                    conversationPairs.push({
                        user: `${userContent}${userFiles}${userDoc}`,
                        assistant: assistantContent
                    });
                }
            }
            
            // Format as conversational memory
            contextChain = conversationPairs
                .slice(-8) // Keep last 8 exchanges
                .map((pair, idx) => {
                    return `[Exchange ${idx + 1}]\nUser: ${pair.user}\nAssistant: ${pair.assistant}`;
                })
                .join('\n\n---\n\n');
            
            contextChain = `=== CONVERSATION HISTORY ===\n${contextChain}\n=== END HISTORY ===`;
        } else {
            // For non-reference queries, include minimal context (just last exchange)
            const lastUserMessages = allMessages
                .filter(msg => msg.role === "user")
                .slice(-2)
                .reverse();
            
            const lastMsg = lastUserMessages[0];
            const secondLastMsg = lastUserMessages[1];
            
            const lastMessage = lastMsg 
                ? `${lastMsg.content || ''}${lastMsg.documentData ? '\n[Document: ' + lastMsg.documentData.substring(0, 400) + '...]' : ''}`
                : null;
                
            const secondLastMessage = secondLastMsg 
                ? `${secondLastMsg.content || ''}${secondLastMsg.documentData ? '\n[Document: ' + secondLastMsg.documentData.substring(0, 400) + '...]' : ''}`
                : null;
                
            contextChain = `LastMessage: ${lastMessage}\nSecondLastMessage: ${secondLastMessage}`;
        }

        // Build document context if available
        const documentContext = documentData 
            ? `\n\nFetched Document Data:\n${documentData}\n\nUse the above document content to answer the user's question.`
            : '';

        // If DeepThink is selected, orchestrate an agent-like flow: memory first, then tools
        let agentContextNote = '';
        if (deepThinkSelected) {
            agentContextNote = `\n\n[Agent Mode]\n- First, use the provided chat context and documents to reason.\n- If more current/real-time information is needed, you may request a web search.\n- Web search tool is available and returns an 'answer' plus 'references'.`;
        }

        // DeepThink strict report instructions
        const reportModeNote = deepThinkSelected
            ? `\n\n[Report Mode]\nProduce a comprehensive, well-structured report with the following sections (use Markdown headings):\n- Title\n- Executive Summary (5-8 concise bullets)\n- Table of Contents\n- Background / Context\n- Key Findings\n- Detailed Analysis (use multiple subsections with ### headings)\n- Data, Examples or Evidence (use bullet points or tables)\n- Limitations and Assumptions\n- Conclusion\n- Recommendations / Next Steps\n\nFormatting rules:\n- Use clear Markdown headings (##, ###) and short paragraphs.\n- Use bullet lists and tables where helpful.\n- When you reference external facts, cite with [n] that maps to Sources.\n- At the end, include a Sources section listing each source on its own line as: [number]: [Title](URL).`
            : '';

        // Generate AI response with smart context
        let userReferringPastMemory = isReferencingPrevious ? 'YES' : 'NO';
        let usedPastMemory = isReferencingPrevious ? 'YES' : 'NO';
        // Print info in terminal
        console.log(`User selected web search: ${userSelectedWebSearch}`);
        console.log(`Used web search: ${usedWebSearch}`);
        console.log(`User referring to past memory: ${userReferringPastMemory}`);
        console.log(`Used past memory: ${usedPastMemory}`);
        let promptTemplate;
        if (webResults && webResults.answer) {
            const sourcesFormatted = (webResults.references || []).map((ref, i) => `[${i+1}]: [${ref.title}](${ref.url})`).join('\n');
            
            promptTemplate = `You are a helpful AI assistant with access to conversation history and web search results.${agentContextNote}${reportModeNote}

${isReferencingPrevious ? contextChain : ''}${documentContext}

Web Search Results:
${webResults.answer}

Current User Question: ${prompt}

CRITICAL INSTRUCTIONS:
- Synthesize information from ALL available sources: conversation history, documents, and web search.
- When citing web sources, use [1], [2], etc. inline in your answer.
- MANDATORY: At the end of your response, you MUST include a "Sources:" section with all the sources listed below.
- Format the Sources section EXACTLY as shown below, with each source on a new line.
- If Report Mode is enabled, follow the strict report structure and include Sources at the very end.

Sources to include at the end of your response:
${sourcesFormatted}

Respond now with your answer followed by the Sources section:`;
        } else {
            promptTemplate = isReferencingPrevious
                ? `You are a helpful AI assistant with full access to conversation history.${agentContextNote}${reportModeNote}

${contextChain}
${documentContext}

Current User Question: ${prompt}

Instructions:
- Review the conversation history carefully to understand the full context.
- Reference specific previous messages or documents when answering.
- Maintain conversation continuity by acknowledging what was discussed before.
- If the user is asking for elaboration, build upon your previous responses.
- If Report Mode is enabled, follow the strict report structure.
- Use clear markdown formatting for readability.

Respond now:`
                : `You are a helpful AI assistant.${agentContextNote}${reportModeNote}

${documentContext}

User Question: ${prompt}

Instructions:
- Provide a clear, comprehensive answer.
- If Report Mode is enabled, follow the strict report structure.
- Use markdown formatting for better readability.

Respond now:`;
        }

        // Use more powerful model for context-heavy queries, faster model for simple queries
        const modelToUse = "llama-3.3-70b-versatile"
        // const modelToUse = isReferencingPrevious 
        //     ? "llama-3.3-70b-versatile"  // Powerful model for context understanding
        //     : "llama-3.1-8b-instant";     // Fast model for standalone questions

        const completion = await openai.chat.completions.create({
            messages: [{ role: "user", content: promptTemplate }],
            model: modelToUse,
            temperature: 0.1,
            max_tokens: 2000,
        });

        // Validate and sanitize the response
        const rawMessage = completion.choices[0].message;
        
        // Type validation and sanitization
        const validatedMessage = {
            role: rawMessage.role === 'assistant' ? 'assistant' : 'assistant', // Force assistant role
            content: typeof rawMessage.content === 'string' 
                ? rawMessage.content.trim() 
                : 'Sorry, I encountered an error generating a response.',
            timestamp: Date.now()
        };

        // Check if response is empty or invalid
        if (!validatedMessage.content || validatedMessage.content.length < 1) {
            validatedMessage.content = 'Sorry, I was unable to generate a proper response. Please try again.';
        }

        // Now push both user message and AI response to the database
        data.messages.push(userPrompt);
        data.messages.push(validatedMessage);
        await data.save();
        
        return NextResponse.json({
            success: true, 
            data: validatedMessage,
            metadata: {
                usedContextualModel: isReferencingPrevious,
                model: modelToUse
            }
        })
    } catch (error) {
        console.log(error);
        return NextResponse.json({ success: false, error: error.message });
    }
}
