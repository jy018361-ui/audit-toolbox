// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MeetingVocabularyPage } from "./MeetingVocabularyPage";
import { ConfirmDialogHost } from "@/components/ConfirmDialog";
import {
  meetingVocabularyDelete,
  meetingVocabularyList,
  meetingVocabularySave,
  runningInDesktopApp,
} from "./api";
import type { MeetingVocabularyEntry } from "./types";

vi.mock("./api", () => ({
  meetingVocabularyList: vi.fn(),
  meetingVocabularySave: vi.fn(),
  meetingVocabularyDelete: vi.fn(),
  runningInDesktopApp: vi.fn(() => true),
}));
let rows: MeetingVocabularyEntry[];
beforeEach(() => {
  rows = [
    {
      id: "1",
      term: "企业资源计划",
      category: "company",
      aliases: ["ERP"],
      definition: "公司管理系统",
      enabled: true,
    },
    {
      id: "2",
      term: "函证",
      category: "industry",
      aliases: [],
      definition: "获取外部证据",
      enabled: false,
    },
  ];
  vi.mocked(runningInDesktopApp).mockReturnValue(true);
  vi.mocked(meetingVocabularyList).mockImplementation(async () => [...rows]);
  vi.mocked(meetingVocabularySave).mockImplementation(async (entry) => {
    const updated = { ...entry, id: entry.id || "new" };
    rows = entry.id
      ? rows.map((row) => (row.id === entry.id ? updated : row))
      : [...rows, updated];
    return [...rows];
  });
  vi.mocked(meetingVocabularyDelete).mockImplementation(async (id) => {
    rows = rows.filter((row) => row.id !== id);
    return [...rows];
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function open() {
  return render(
    <MemoryRouter>
      <MeetingVocabularyPage />
      <ConfirmDialogHost />
    </MemoryRouter>,
  );
}

it("按区域呈现词块，可按名称简称含义搜索", async () => {
  open();
  await screen.findByRole("button", { name: "编辑 企业资源计划" });
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.getByLabelText("公司词汇词块")).toHaveTextContent(
    "企业资源计划",
  );
  expect(screen.getByLabelText("行业词汇词块")).toHaveTextContent("函证");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "erp" } });
  expect(screen.getByText("企业资源计划")).toBeVisible();
  expect(screen.queryByText("函证")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "获取外部" },
  });
  expect(screen.getByText("函证")).toBeVisible();
  expect(screen.queryByText("企业资源计划")).not.toBeInTheDocument();
});

it("新增并编辑词条，保存后重新进入可读取", async () => {
  const view = open();
  await screen.findByRole("button", { name: "编辑 企业资源计划" });
  fireEvent.click(screen.getByRole("button", { name: "新增词条" }));
  fireEvent.change(screen.getByLabelText("标准名称"), {
    target: { value: " 新公司 " },
  });
  fireEvent.change(screen.getByLabelText("简称 / 别名"), {
    target: { value: "新司，XC、XC" },
  });
  fireEvent.change(screen.getByLabelText("含义 / 使用语境"), {
    target: { value: "主要经营主体" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存词条" }));
  await screen.findByText("新公司");
  expect(meetingVocabularySave).toHaveBeenCalledWith(
    expect.objectContaining({
      term: "新公司",
      aliases: ["新司", "XC"],
      enabled: true,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "编辑 新公司" }));
  fireEvent.change(screen.getByLabelText("标准名称"), {
    target: { value: "新公司全称" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存词条" }));
  await screen.findByText("新公司全称");
  view.unmount();
  open();
  expect(await screen.findByText("新公司全称")).toBeVisible();
});

it("启用失败保持原状态，编辑保存失败保留输入，取消不写库", async () => {
  open();
  await screen.findByRole("button", { name: "编辑 企业资源计划" });
  vi.mocked(meetingVocabularySave).mockRejectedValueOnce({
    userMessage: "写入失败",
  });
  fireEvent.click(screen.getByRole("button", { name: "编辑 函证" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "启用该词条" }));
  fireEvent.click(screen.getByRole("button", { name: "保存词条" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("写入失败");
  expect(screen.getByRole("checkbox", { name: "启用该词条" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑 函证" }));
  expect(
    screen.getByRole("checkbox", { name: "启用该词条" }),
  ).not.toBeChecked();
  fireEvent.change(screen.getByLabelText("标准名称"), {
    target: { value: "新的函证名称" },
  });
  vi.mocked(meetingVocabularySave).mockRejectedValueOnce({
    userMessage: "重复词条",
  });
  fireEvent.click(screen.getByRole("button", { name: "保存词条" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("重复词条");
  expect(screen.getByLabelText("标准名称")).toHaveValue("新的函证名称");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(meetingVocabularySave).toHaveBeenCalledTimes(2);
  expect(screen.getByText("函证")).toBeVisible();
});

it("删除需要确认，取消保留，确认后移除", async () => {
  open();
  await screen.findByRole("button", { name: "编辑 企业资源计划" });
  fireEvent.click(screen.getByRole("button", { name: "编辑 函证" }));
  fireEvent.click(screen.getByRole("button", { name: "删除 函证" }));
  fireEvent.click(await screen.findByRole("button", { name: "取消" }));
  expect(meetingVocabularyDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "删除 函证" }));
  fireEvent.click(await screen.findByRole("button", { name: /^删除$/ }));
  await waitFor(() =>
    expect(screen.queryByText("函证")).not.toBeInTheDocument(),
  );
  expect(meetingVocabularyDelete).toHaveBeenCalledWith("2");
});

it("读取失败不能新增，可重试；预览模式禁用维护", async () => {
  vi.mocked(meetingVocabularyList).mockRejectedValueOnce({
    userMessage: "读取失败",
  });
  const view = open();
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "新增词条" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await screen.findByRole("button", { name: "编辑 企业资源计划" });
  expect(screen.getByRole("button", { name: "新增词条" })).toBeEnabled();
  view.unmount();
  vi.mocked(runningInDesktopApp).mockReturnValue(false);
  open();
  await screen.findByRole("button", { name: "编辑 企业资源计划" });
  expect(screen.getByRole("note")).toHaveTextContent("浏览器预览模式");
  expect(screen.getByRole("button", { name: "新增词条" })).toBeDisabled();
});
