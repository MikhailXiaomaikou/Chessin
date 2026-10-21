import { notifications } from "@mantine/notifications";
import { IconX } from "@tabler/icons-react";
import { error } from "@tauri-apps/plugin-log";
import i18n from "i18next";

type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

/**
 * Unwraps a backend `Result`. On error: logs it, shows a toast with a
 * translated title and the backend message as the detail, then throws.
 */
export function unwrap<T>(result: Result<T, string>): T {
  if (result.status === "ok") {
    return result.data;
  }
  error(result.error);
  notifications.show({
    title: i18n.t("Errors.Toast.Title"),
    message: result.error,
    color: "red",
    icon: <IconX aria-hidden="true" />,
  });
  throw new Error(result.error);
}
