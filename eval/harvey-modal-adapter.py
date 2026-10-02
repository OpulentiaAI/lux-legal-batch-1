"""Chat Completions adapters for separately pinned inference transports."""

import os
import re

import openai

from harness.adapters.base import ModelAdapter, ModelResponse, ToolCall


class GatewayReasoningAdapter(ModelAdapter):
    def __init__(self, model, max_tokens=4000, reasoning_effort=None, provider_only=None, capture_usage=False,
                 inference_provider="gateway", provider_model=None):
        super().__init__(model)
        if inference_provider not in ("gateway", "runanywhere"):
            raise ValueError("Unknown inference provider; no fallback permitted")
        self.native = inference_provider == "runanywhere"
        if self.native:
            import httpx

            if model != "xiaomi/mimo-v2.6-pro" or not isinstance(provider_model, str) or not re.fullmatch(r"(?:xiaomi/)?mimo-v2\.6-pro", provider_model, re.I):
                raise ValueError("An authenticated RunAnywhere MiMo model ID is required")
            if provider_only is not None or reasoning_effort is not None:
                raise ValueError("RunAnywhere does not declare Gateway routing or reasoning-effort parameters")
            if not os.environ.get("RUNA_CLOUD_KEY"):
                raise ValueError("RUNA_CLOUD_KEY is required; no Gateway fallback")
            self.client = openai.OpenAI(base_url="https://inference.runanywhere.ai/v1", api_key=os.environ["RUNA_CLOUD_KEY"],
                                        timeout=600, max_retries=0, http_client=httpx.Client(follow_redirects=False))
        else:
            if provider_model is not None:
                raise ValueError("Gateway does not accept a native provider model override")
            self.client = openai.OpenAI()
        self.request_model = provider_model if self.native else model
        self.max_tokens = max_tokens
        self.reasoning_effort = reasoning_effort
        self.provider_only = provider_only
        self.usage_records = [] if capture_usage else None

    def chat(self, messages, tools):
        response = self.client.chat.completions.create(
            model=self.request_model,
            messages=messages,
            tools=[{"type": "function", "function": {
                "name": tool["name"], "description": tool["description"],
                "parameters": tool["parameters"],
            }} for tool in tools],
            **({"max_tokens": self.max_tokens} if self.native else {"max_completion_tokens": self.max_tokens}),
            **({"reasoning_effort": self.reasoning_effort} if self.reasoning_effort else {}),
            extra_body={"providerOptions": {"gateway": {"only": self.provider_only}}} if self.provider_only else {},
        )
        if self.usage_records is not None:
            usage = response.usage.model_dump() if response.usage else {}
            record = {key: value for key, value in usage.items()
                      if key in {"prompt_tokens", "completion_tokens", "total_tokens", "cost", "gateway_cost", "market_cost"}
                      and isinstance(value, (int, float)) and not isinstance(value, bool)}
            finish_reason = getattr(response.choices[0], "finish_reason", None)
            record["finishReason"] = finish_reason if isinstance(finish_reason, str) else None
            if self.native:
                record["inferenceProvider"] = "runanywhere"
                record["requestedModel"] = self.request_model
                record["responseModel"] = getattr(response, "model", None)
                record["requestId"] = getattr(response, "id", None)
            self.usage_records.append(record)
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


class ModalDeepSeekAdapter(GatewayReasoningAdapter):
    def __init__(self, model, max_tokens=4000, capture_usage=False):
        super().__init__(model, max_tokens=max_tokens, provider_only=["modal"], capture_usage=capture_usage)


class RunAnywhereAdapter(GatewayReasoningAdapter):
    def __init__(self, model, provider_model, max_tokens=4000, capture_usage=False):
        super().__init__(model, max_tokens=max_tokens, capture_usage=capture_usage,
                         inference_provider="runanywhere", provider_model=provider_model)
