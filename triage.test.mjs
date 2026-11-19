import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

process.env.PORT = "0";
const { server } = await import("./server.mjs");
if (!server.listening) await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;

function post(body) {
  return fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

test("Разбор входящих заявок", async (t) => {
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  await t.test("API отклоняет некорректный ввод", async () => {
    for (const body of ["", "{", "null", "{}", '{"text":42}', '{"text":""}', '{"text":"  " }']) {
      const reply = await post(body);
      assert.equal(reply.status, 400, body);
      assert.deepEqual(await reply.json(), { status: "invalid_input" }, body);
    }
  });

  await t.test("API возвращает допустимую тему и черновик", async () => {
    for (const [text, topic] of [
      ["Когда будет доставка?", "delivery"],
      ["Подскажите цену", "pricing"],
      ["Добрый день", "other"],
    ]) {
      const reply = await post(JSON.stringify({ text }));
      assert.equal(reply.status, 200);
      assert.deepEqual(await reply.json(), {
        status: "ready",
        topic,
        draft: "Спасибо за обращение. Уточним детали заявки.",
      });
    }
  });

  for (const text of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    await t.test(`API переводит заявку на ручной разбор при ${text}`, async () => {
      const start = performance.now();
      const reply = await post(JSON.stringify({ text }));
      assert.equal(reply.status, 200);
      assert.deepEqual(await reply.json(), { status: "manual_review", topic: null, draft: null });
      if (text === "[timeout]") {
        assert.ok(performance.now() - start < 1_100, "Ответ должен прийти до завершения задержки имитатора");
      }
    });
  }

  await t.test("Обработчик формы заменяет предыдущий черновик сообщением о ручном разборе", async () => {
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    const script = (await page.text()).match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    const button = { disabled: false };
    const message = { value: "", focus() {} };
    const result = { textContent: "" };
    let submit;
    let requests = 0;
    const form = {
      querySelector: () => button,
      addEventListener: (type, listener) => {
        assert.equal(type, "submit");
        submit = () => listener({ preventDefault() {} });
      },
    };
    const elements = new Map([["form", form], ["#message", message], ["#result", result]]);
    runInNewContext(script, {
      document: { querySelector: (selector) => elements.get(selector) },
      fetch: (url, options) => {
        requests++;
        return fetch(new URL(url, baseUrl), options);
      },
    });

    await submit();
    assert.equal(result.textContent, "Введите текст заявки.");
    assert.equal(requests, 0);

    message.value = "Вопрос про доставку";
    await submit();
    assert.match(result.textContent, /Тема: Доставка\nЧерновик ответа:\nСпасибо за обращение/);

    message.value = "[error]";
    const pending = submit();
    assert.equal(result.textContent, "Разбираем заявку…");
    await pending;
    assert.equal(result.textContent, "Не удалось подготовить черновик. Разберите заявку вручную.");
    assert.equal(button.disabled, false);
  });
});
