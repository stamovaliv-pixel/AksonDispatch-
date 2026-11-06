# Akson Dispatch v1.0.10 — уведомления и browser push

## Что добавлено
- Центр уведомлений в шапке: счётчик непрочитанных, список последних уведомлений, отметка прочитанного и действие «Прочитать все».
- Всплывающие уведомления внутри приложения при новых событиях в реальном времени.
- Подписка браузера на системные push-уведомления.
- Service Worker для отображения push при закрытой вкладке.
- Адресные уведомления по ролям при создании, отмене и изменении заявок.
- Edge Function отправляет push только на устройства конкретного получателя.
- Устаревшие подписки автоматически удаляются при ответах push-сервера 404/410.

## Состав патча
- `src/App.tsx`
- `src/style.css`
- `public/sw.js`
- `public/push-setup.html`
- `supabase/migrations/0011_browser_push_notifications.sql`
- `supabase/functions/send-push/index.ts`
- `supabase/config.toml`
- `PUSH_SETUP_RU.md`

## Порядок внедрения
1. Заменить/добавить файлы в GitHub.
2. Применить SQL миграцию 0011 в Supabase.
3. Развернуть Edge Function `send-push`, настроить Secrets и отключить Verify JWT для неё.
4. Создать Database Webhook на INSERT таблицы `public.user_notifications`.
5. Сгенерировать ключи на `/push-setup.html`, добавить публичный ключ в Vercel и выполнить Redeploy.
6. Каждый пользователь включает push в колокольчике приложения.

Подробная пошаговая настройка находится в `PUSH_SETUP_RU.md`.
