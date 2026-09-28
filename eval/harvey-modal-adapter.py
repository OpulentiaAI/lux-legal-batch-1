"""Chat Completions adapter for the Modal-pinned DeepSeek comparison profile."""

import openai

from harness.adapters.base import ModelAdapter, ModelResponse, ToolCall


class ModalDeepSeekAdapter(ModelAdapter):
    def __init__(self, model, max_tokens=4000):
        super().__init__(model)
        self.max_tokens = max_tokens
        self.client = openai.OpenAI()

    def chat(self, messages, tools):
        response = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            tools=[{"type": "function", "function": {
                "name": tool["name"], "description": tool["description"],
                "parameters": tool["parameters"],
            }} for tool in tools],
            max_completion_tokens=self.max_tokens,
            extra_body={"providerOptions": {"gateway": {"only": ["modal"]}}},
        )
        message = response.choices[0].message.model_dump(exclude_none=True)
        calls = [ToolCall(id=call["id"], name=call["function"]["name"],
                          arguments=call["function"]["arguments"])
                 for call in message.get("tool_calls", [])]
        return ModelResponse(
            message=message,
            tool_calls=calls,
            text=message.get("content") or "",
            input_tokens=response.usage.prompt_tokens if response.usage else 0,
            output_tokens=response.usage.completion_tokens if response.usage else 0,
        )

    def make_tool_result_messages(self, results):
        return [{"role": "tool", "tool_call_id": call_id, "content": result}
                for call_id, result in results]

    def make_system_message(self, content):
        return {"role": "system", "content": content}

    def make_user_message(self, content):
        return {"role": "user", "content": content}
