import m, { Children, Component, Vnode } from "mithril"
import { AppHeaderAttrs, Header } from "../../gui/Header.js"
import { ColumnType, ViewColumn } from "../../gui/base/ViewColumn"
import { lang } from "../../misc/LanguageViewModel"
import { ViewSlider } from "../../gui/nav/ViewSlider.js"
import type { Shortcut } from "../../misc/KeyManager"
import { keyManager } from "../../misc/KeyManager"
import { Icons } from "../../gui/base/icons/Icons"
import { assertNotNull, downcast, getStartOfDay, memoized, ofClass } from "@tutao/tutanota-utils"
import type { CalendarEvent, GroupSettings, UserSettingsGroupRoot } from "../../api/entities/tutanota/TypeRefs.js"
import { createGroupSettings } from "../../api/entities/tutanota/TypeRefs.js"
import { defaultCalendarColor, GroupType, Keys, reverse, ShareCapability, TimeFormat, WeekStart } from "../../api/common/TutanotaConstants"
import { locator } from "../../api/main/MainLocator"
import { getStartOfTheWeekOffset, getStartOfTheWeekOffsetForUser, getTimeZone, shouldDefaultToAmPmTimeFormat } from "../date/CalendarUtils"
import { ButtonColor, ButtonType } from "../../gui/base/Button.js"
import { NavButton, NavButtonColor } from "../../gui/base/NavButton.js"
import { CalendarMonthView } from "./CalendarMonthView"
import { DateTime } from "luxon"
import { NotFoundError } from "../../api/common/error/RestError"
import { CalendarAgendaView, CalendarAgendaViewAttrs } from "./CalendarAgendaView"
import type { GroupInfo } from "../../api/entities/sys/TypeRefs.js"
import { showEditCalendarDialog } from "./EditCalendarDialog"
import { styles } from "../../gui/styles"
import { MultiDayCalendarView } from "./MultiDayCalendarView"
import { Dialog } from "../../gui/base/Dialog"
import { isApp } from "../../api/common/Env"
import { px, size } from "../../gui/size"
import { FolderColumnView } from "../../gui/FolderColumnView.js"
import { deviceConfig } from "../../misc/DeviceConfig"
import { exportCalendar, showCalendarImportDialog } from "../export/CalendarImporterDialog"
import { showNotAvailableForFreeDialog } from "../../misc/SubscriptionDialogs"
import { getSharedGroupName, hasCapabilityOnGroup, loadGroupMembers } from "../../sharing/GroupUtils"
import { showGroupSharingDialog } from "../../sharing/view/GroupSharingDialog"
import { GroupInvitationFolderRow } from "../../sharing/view/GroupInvitationFolderRow"
import { SidebarSection } from "../../gui/SidebarSection"
import type { HtmlSanitizer } from "../../misc/HtmlSanitizer"
import { ProgrammingError } from "../../api/common/error/ProgrammingError"
import { calendarNavConfiguration, CalendarViewType, getIconForViewType } from "./CalendarGuiUtils"
import { CalendarViewModel, MouseOrPointerEvent } from "./CalendarViewModel"
import { showNewCalendarEventEditDialog } from "./eventeditor/CalendarEventEditDialog.js"
import { CalendarEventPopup } from "./eventpopup/CalendarEventPopup.js"
import { showProgressDialog } from "../../gui/dialogs/ProgressDialog"
import type { CalendarInfo } from "../model/CalendarModel"
import type Stream from "mithril/stream"
import { IconButton } from "../../gui/base/IconButton.js"
import { createDropdown } from "../../gui/base/Dropdown.js"
import { ButtonSize } from "../../gui/base/ButtonSize.js"
import { BottomNav } from "../../gui/nav/BottomNav.js"
import { DrawerMenuAttrs } from "../../gui/nav/DrawerMenu.js"
import { BaseTopLevelView } from "../../gui/BaseTopLevelView.js"
import { TopLevelAttrs, TopLevelView } from "../../TopLevelView.js"
import { getEventWithDefaultTimes } from "../../api/common/utils/CommonCalendarUtils.js"
import { BackgroundColumnLayout } from "../../gui/BackgroundColumnLayout.js"
import { theme } from "../../gui/theme.js"
import { CalendarMobileHeader } from "./CalendarMobileHeader.js"
import { CalendarDesktopToolbar } from "./CalendarDesktopToolbar.js"
import { CalendarOperation } from "../date/eventeditor/CalendarEventModel.js"
import { DaySelectorPopup } from "../date/DaySelectorPopup.js"
import { DaySelectorSidebar } from "../date/DaySelectorSidebar.js"

export type GroupColors = Map<Id, string>

export interface CalendarViewAttrs extends TopLevelAttrs {
	drawerAttrs: DrawerMenuAttrs
	header: AppHeaderAttrs
	calendarViewModel: CalendarViewModel
}

const CalendarViewTypeByValue = reverse(CalendarViewType)

export class CalendarView extends BaseTopLevelView implements TopLevelView<CalendarViewAttrs> {
	private readonly sidebarColumn: ViewColumn
	private readonly contentColumn: ViewColumn
	private readonly viewSlider: ViewSlider
	private currentViewType: CalendarViewType
	private readonly viewModel: CalendarViewModel
	// For sanitizing event descriptions, which get rendered as html in the CalendarEventPopup
	private readonly htmlSanitizer: Promise<HtmlSanitizer>
	private isDaySelectorExpanded: boolean = false
	oncreate: Component["oncreate"]
	onremove: Component["onremove"]

	constructor(vnode: Vnode<CalendarViewAttrs>) {
		super()
		const userId = locator.logins.getUserController().user._id

		this.viewModel = vnode.attrs.calendarViewModel
		this.currentViewType = deviceConfig.getDefaultCalendarView(userId) || CalendarViewType.MONTH
		this.htmlSanitizer = import("../../misc/HtmlSanitizer").then((m) => m.htmlSanitizer)
		this.sidebarColumn = new ViewColumn(
			{
				view: () =>
					m(FolderColumnView, {
						drawer: vnode.attrs.drawerAttrs,
						button: styles.isDesktopLayout()
							? {
									type: ButtonType.FolderColumnHeader,
									label: "newEvent_action",
									click: () => this._createNewEventDialog(),
							  }
							: null,
						content: [
							styles.isDesktopLayout()
								? m(DaySelectorSidebar, {
										selectedDate: this.viewModel.selectedDate(),
										onDateSelected: (date) => {
											this._setUrl(this.currentViewType, date)

											m.redraw()
										},
										startOfTheWeekOffset: getStartOfTheWeekOffset(
											downcast(locator.logins.getUserController().userSettingsGroupRoot.startOfTheWeek),
										),
										eventsForDays: this.viewModel.eventsForDays,
										showDaySelection: this.currentViewType !== CalendarViewType.MONTH && this.currentViewType !== CalendarViewType.WEEK,
										highlightToday: true,
										highlightSelectedWeek: this.currentViewType === CalendarViewType.WEEK,
								  })
								: null,
							m(
								SidebarSection,
								{
									name: "yourCalendars_label",
									button: m(IconButton, {
										title: "addCalendar_action",
										colors: ButtonColor.Nav,
										click: () => this._onPressedAddCalendar(),
										icon: Icons.Add,
										size: ButtonSize.Compact,
									}),
								},
								this._renderCalendars(false),
							),
							m(
								SidebarSection,
								{
									name: "otherCalendars_label",
								},
								this._renderCalendars(true),
							),
							this.viewModel.calendarInvitations().length > 0
								? m(
										SidebarSection,
										{
											name: "calendarInvitations_label",
										},
										this.viewModel.calendarInvitations().map((invitation) =>
											m(GroupInvitationFolderRow, {
												invitation,
											}),
										),
								  )
								: null,
						],
						ariaLabel: "calendar_label",
					}),
			},
			ColumnType.Foreground,
			size.first_col_min_width,
			size.first_col_max_width,
			() => (this.currentViewType === CalendarViewType.WEEK ? lang.get("month_label") : lang.get("calendar_label")),
		)
		const getGroupColors = memoized((userSettingsGroupRoot: UserSettingsGroupRoot) => {
			return userSettingsGroupRoot.groupSettings.reduce((acc, gc) => {
				acc.set(gc.group, gc.color)
				return acc
			}, new Map())
		})
		this.contentColumn = new ViewColumn(
			{
				view: () => {
					const groupColors = getGroupColors(locator.logins.getUserController().userSettingsGroupRoot)

					switch (this.currentViewType) {
						case CalendarViewType.MONTH:
							return m(BackgroundColumnLayout, {
								backgroundColor: theme.navigation_bg,
								desktopToolbar: () => this.renderDesktopToolbar(),
								mobileHeader: () => this.renderMobileHeader(vnode.attrs.header),
								columnLayout: m(CalendarMonthView, {
									temporaryEvents: this.viewModel.temporaryEvents,
									eventsForDays: this.viewModel.eventsForDays,
									getEventsOnDaysToRender: this.viewModel.getEventsOnDaysToRender.bind(this.viewModel),
									onEventClicked: (calendarEvent, domEvent) => this._onEventSelected(calendarEvent, domEvent, this.htmlSanitizer),
									onNewEvent: (date) => {
										this._createNewEventDialog(date)
									},
									selectedDate: this.viewModel.selectedDate(),
									onDateSelected: (date, calendarViewType) => {
										this._setUrl(calendarViewType, date)
									},
									onChangeMonth: (next) => this._viewPeriod(CalendarViewType.MONTH, next),
									amPmFormat: locator.logins.getUserController().userSettingsGroupRoot.timeFormat === TimeFormat.TWELVE_HOURS,
									startOfTheWeek: downcast(locator.logins.getUserController().userSettingsGroupRoot.startOfTheWeek),
									groupColors,
									hiddenCalendars: this.viewModel.hiddenCalendars,
									dragHandlerCallbacks: this.viewModel,
								}),
							})
						case CalendarViewType.DAY:
							return m(BackgroundColumnLayout, {
								backgroundColor: theme.navigation_bg,
								desktopToolbar: () => this.renderDesktopToolbar(),
								mobileHeader: () => this.renderMobileHeader(vnode.attrs.header),
								columnLayout: m(MultiDayCalendarView, {
									temporaryEvents: this.viewModel.temporaryEvents,
									getEventsOnDays: this.viewModel.getEventsOnDaysToRender.bind(this.viewModel),
									daysInPeriod: 1,
									onEventClicked: (event, domEvent) => this._onEventSelected(event, domEvent, this.htmlSanitizer),
									onNewEvent: (date) => {
										this._createNewEventDialog(date)
									},
									selectedDate: this.viewModel.selectedDate(),
									onDateSelected: (date) => {
										this.viewModel.selectedDate(date)
										this._setUrl(CalendarViewType.DAY, date)
									},
									groupColors,
									hiddenCalendars: this.viewModel.hiddenCalendars,
									onChangeViewPeriod: (next) => this._viewPeriod(CalendarViewType.DAY, next),
									startOfTheWeek: downcast(locator.logins.getUserController().userSettingsGroupRoot.startOfTheWeek),
									dragHandlerCallbacks: this.viewModel,
									isDaySelectorExpanded: this.isDaySelectorExpanded,
									eventsForDays: this.viewModel.eventsForDays,
								}),
							})

						case CalendarViewType.WEEK:
							return m(BackgroundColumnLayout, {
								backgroundColor: theme.navigation_bg,
								desktopToolbar: () => this.renderDesktopToolbar(),
								mobileHeader: () => this.renderMobileHeader(vnode.attrs.header),
								columnLayout: m(MultiDayCalendarView, {
									temporaryEvents: this.viewModel.temporaryEvents,
									getEventsOnDays: this.viewModel.getEventsOnDaysToRender.bind(this.viewModel),
									daysInPeriod: 7,
									onEventClicked: (event, domEvent) => this._onEventSelected(event, domEvent, this.htmlSanitizer),
									onNewEvent: (date) => {
										this._createNewEventDialog(date)
									},
									selectedDate: this.viewModel.selectedDate(),
									onDateSelected: (date, viewType) => {
										this._setUrl(viewType ?? CalendarViewType.WEEK, date)
									},
									startOfTheWeek: downcast(locator.logins.getUserController().userSettingsGroupRoot.startOfTheWeek),
									groupColors,
									hiddenCalendars: this.viewModel.hiddenCalendars,
									onChangeViewPeriod: (next) => this._viewPeriod(CalendarViewType.WEEK, next),
									dragHandlerCallbacks: this.viewModel,
									isDaySelectorExpanded: this.isDaySelectorExpanded,
									eventsForDays: this.viewModel.eventsForDays,
								}),
							})

						case CalendarViewType.AGENDA:
							return m(BackgroundColumnLayout, {
								backgroundColor: theme.navigation_bg,
								desktopToolbar: () => this.renderDesktopToolbar(),
								mobileHeader: () => this.renderMobileHeader(vnode.attrs.header),
								columnLayout: m(CalendarAgendaView, {
									selectedDate: this.viewModel.selectedDate(),
									eventsForDays: this.viewModel.eventsForDays,
									amPmFormat: shouldDefaultToAmPmTimeFormat(),
									onEventClicked: (event, domEvent) => {
										if (styles.isDesktopLayout()) {
											this.viewModel.previewEvent(event)
										} else {
											this._onEventSelected(event, domEvent, this.htmlSanitizer)
										}
									},
									groupColors,
									hiddenCalendars: this.viewModel.hiddenCalendars,
									startOfTheWeekOffset: getStartOfTheWeekOffsetForUser(locator.logins.getUserController().userSettingsGroupRoot),
									isDaySelectorExpanded: this.isDaySelectorExpanded,
									onDateSelected: (date) => this._setUrl(CalendarViewType.AGENDA, date),
									onShowDate: (date: Date) => this._setUrl(CalendarViewType.DAY, date),
									eventPreviewModel: this.viewModel.eventPreviewModel,
								} satisfies CalendarAgendaViewAttrs),
							})

						default:
							throw new ProgrammingError(`invalid CalendarViewType: "${this.currentViewType}"`)
					}
				},
			},
			ColumnType.Background,
			size.second_col_min_width + size.third_col_min_width,
			size.third_col_max_width,
		)
		this.viewSlider = new ViewSlider([this.sidebarColumn, this.contentColumn])

		const shortcuts = this._setupShortcuts()

		const streamListeners: Stream<void>[] = []

		this.oncreate = () => {
			keyManager.registerShortcuts(shortcuts)
			streamListeners.push(
				this.viewModel.calendarInvitations.map(() => {
					m.redraw()
				}),
			)
			streamListeners.push(this.viewModel.redraw.map(m.redraw))
		}

		this.onremove = () => {
			keyManager.unregisterShortcuts(shortcuts)

			for (let listener of streamListeners) {
				listener.end(true)
			}
		}
	}

	private renderDesktopToolbar(): Children {
		const navConfig = calendarNavConfiguration(
			this.currentViewType,
			this.viewModel.selectedDate(),
			this.viewModel.weekStart,
			"detailed",
			(viewType, next) => this._viewPeriod(viewType, next),
		)
		return m(CalendarDesktopToolbar, {
			navConfig,
			viewType: this.currentViewType,
			onToday: () => this._setUrl(m.route.param("view"), new Date()),
			onViewTypeSelected: (viewType) => this._setUrl(viewType, this.viewModel.selectedDate()),
		})
	}

	private renderMobileHeader(header: AppHeaderAttrs) {
		return m(CalendarMobileHeader, {
			...header,
			viewType: this.currentViewType,
			viewSlider: this.viewSlider,
			showExpandIcon: !styles.isDesktopLayout() && this.currentViewType !== CalendarViewType.MONTH,
			isDaySelectorExpanded: this.isDaySelectorExpanded,
			navConfiguration: calendarNavConfiguration(
				this.currentViewType,
				this.viewModel.selectedDate(),
				this.viewModel.weekStart,
				"short",
				(viewType, next) => this._viewPeriod(viewType, next),
			),
			onCreateEvent: () => this._createNewEventDialog(),
			onToday: () => this._setUrl(m.route.param("view"), new Date()),
			onViewTypeSelected: (viewType) => this._setUrl(viewType, this.viewModel.selectedDate()),
			onTap: (_event, dom) => {
				if (this.currentViewType !== CalendarViewType.MONTH && styles.isSingleColumnLayout()) {
					return (this.isDaySelectorExpanded = !this.isDaySelectorExpanded)
				}

				if (!styles.isDesktopLayout() && this.currentViewType !== CalendarViewType.MONTH) {
					if (this.isDaySelectorExpanded) this.isDaySelectorExpanded = false

					this.showCalendarPopup(dom)
				}
			},
		})
	}

	_setupShortcuts(): Shortcut[] {
		return [
			{
				key: Keys.ONE,
				exec: () => this._setUrl(CalendarViewType.WEEK, this.viewModel.selectedDate()),
				help: "switchWeekView_action",
			},
			{
				key: Keys.TWO,
				exec: () => this._setUrl(CalendarViewType.MONTH, this.viewModel.selectedDate()),
				help: "switchMonthView_action",
			},
			{
				key: Keys.THREE,
				exec: () => this._setUrl(CalendarViewType.AGENDA, this.viewModel.selectedDate()),
				help: "switchAgendaView_action",
			},
			{
				key: Keys.T,
				exec: () => this._setUrl(m.route.param("view"), new Date()),
				help: "viewToday_action",
			},
			{
				key: Keys.J,
				enabled: () => this.currentViewType !== CalendarViewType.AGENDA,
				exec: () => this._viewPeriod(this.currentViewType, true),
				help: "viewNextPeriod_action",
			},
			{
				key: Keys.K,
				enabled: () => this.currentViewType !== CalendarViewType.AGENDA,
				exec: () => this._viewPeriod(this.currentViewType, false),
				help: "viewPrevPeriod_action",
			},
			{
				key: Keys.N,
				exec: () => {
					this._createNewEventDialog()
				},
				help: "newEvent_action",
			},
		]
	}

	async _createNewEventDialog(date: Date | null = null): Promise<void> {
		const dateToUse = date ?? this.viewModel.selectedDate()

		// Disallow creation of events when there is no existing calendar
		let calendarInfos = this.viewModel.getCalendarInfosCreateIfNeeded()

		if (calendarInfos instanceof Promise) {
			await showProgressDialog("pleaseWait_msg", calendarInfos)
		}

		const mailboxDetails = await locator.mailModel.getUserMailboxDetails()
		const mailboxProperties = await locator.mailModel.getMailboxProperties(mailboxDetails.mailboxGroupRoot)
		const model = await locator.calendarEventModel(CalendarOperation.Create, getEventWithDefaultTimes(dateToUse), mailboxDetails, mailboxProperties, null)
		if (model) {
			await showNewCalendarEventEditDialog(model)
		}
	}

	_viewPeriod(viewType: CalendarViewType, next: boolean) {
		let duration
		let unit: "day" | "week" | "month"

		switch (viewType) {
			case CalendarViewType.MONTH:
				duration = {
					month: 1,
				}
				unit = "month"
				break

			case CalendarViewType.WEEK:
				duration = {
					week: 1,
				}
				unit = "week"
				break

			case CalendarViewType.DAY:
				duration = {
					day: 1,
				}
				unit = "day"
				break
			case CalendarViewType.AGENDA:
				duration = styles.isDesktopLayout()
					? { day: 1 }
					: {
							week: this.isDaySelectorExpanded ? 0 : 1,
							month: this.isDaySelectorExpanded ? 1 : 0,
					  }
				unit = "day"
				break

			default:
				throw new ProgrammingError("Invalid CalendarViewType: " + viewType)
		}

		const dateTime = DateTime.fromJSDate(this.viewModel.selectedDate())
		const newDate = next ? dateTime.plus(duration).startOf(unit).toJSDate() : dateTime.minus(duration).startOf(unit).toJSDate()

		this.viewModel.selectedDate(newDate)
		this._setUrl(viewType, newDate)

		m.redraw()
	}

	_renderCalendarViewButtons(): Children {
		const calendarViewValues: Array<{ name: string; viewType: CalendarViewType }> = [
			{
				name: lang.get("agenda_label"),
				viewType: CalendarViewType.AGENDA,
			},
			{
				name: lang.get("day_label"),
				viewType: CalendarViewType.DAY,
			},
			{
				name: lang.get("week_label"),
				viewType: CalendarViewType.WEEK,
			},
			{
				name: lang.get("month_label"),
				viewType: CalendarViewType.MONTH,
			},
		]

		return calendarViewValues.map((viewData) =>
			m(
				".folder-row.flex.flex-row", // undo the padding of NavButton and prevent .folder-row > a from selecting NavButton
				m(
					".flex-grow.mlr-button",
					m(NavButton, {
						label: () => viewData.name,
						icon: () => getIconForViewType(viewData.viewType),
						href: "#",
						isSelectedPrefix: this.currentViewType == viewData.viewType,
						colors: NavButtonColor.Nav,
						// Close side menu
						click: () => {
							this._setUrl(viewData.viewType, this.viewModel.selectedDate())

							this.viewSlider.focus(this.contentColumn)
						},
						persistentBackground: true,
					}),
				),
			),
		)
	}

	_onPressedAddCalendar() {
		if (locator.logins.getUserController().getCalendarMemberships().length === 0) {
			this._showCreateCalendarDialog()
		} else {
			import("../../misc/SubscriptionDialogs")
				.then((SubscriptionDialogUtils) => SubscriptionDialogUtils.checkPaidSubscription())
				.then((ok) => {
					if (ok) {
						this._showCreateCalendarDialog()
					}
				})
		}
	}

	_showCreateCalendarDialog() {
		showEditCalendarDialog(
			{
				name: "",
				color: Math.random().toString(16).slice(-6),
			},
			"add_action",
			false,
			async (dialog, properties) => {
				const calendarModel = await locator.calendarModel()
				await calendarModel.createCalendar(properties.name, properties.color)
				dialog.close()
			},
			"save_action",
		)
	}

	_renderCalendars(shared: boolean): Children {
		return this.viewModel.calendarInfos.isLoaded()
			? Array.from(this.viewModel.calendarInfos.getLoaded().values())
					.filter((calendarInfo) => calendarInfo.shared === shared)
					.map((calendarInfo) => {
						const { userSettingsGroupRoot } = locator.logins.getUserController()
						const existingGroupSettings = userSettingsGroupRoot.groupSettings.find((gc) => gc.group === calendarInfo.groupInfo.group) ?? null
						const colorValue = "#" + (existingGroupSettings ? existingGroupSettings.color : defaultCalendarColor)
						const groupRootId = calendarInfo.groupRoot._id
						return m(".folder-row.flex-start.plr-button", [
							m(".flex.flex-grow.center-vertically.button-height", [
								m(".calendar-checkbox", {
									onclick: () => {
										const newHiddenCalendars = new Set(this.viewModel.hiddenCalendars)
										this.viewModel.hiddenCalendars.has(groupRootId)
											? newHiddenCalendars.delete(groupRootId)
											: newHiddenCalendars.add(groupRootId)

										this.viewModel.setHiddenCalendars(newHiddenCalendars)
									},
									style: {
										"border-color": colorValue,
										background: this.viewModel.hiddenCalendars.has(groupRootId) ? "" : colorValue,
										transition: "all 0.3s",
										cursor: "pointer",
										marginLeft: px(size.hpad_button),
									},
								}),
								m(
									".pl-m.b.flex-grow.text-ellipsis",
									{
										style: {
											width: 0,
										},
									},
									getSharedGroupName(calendarInfo.groupInfo, locator.logins.getUserController(), shared),
								),
							]),
							this._createCalendarActionDropdown(calendarInfo, colorValue, existingGroupSettings, userSettingsGroupRoot, shared),
						])
					})
			: null
	}

	_createCalendarActionDropdown(
		calendarInfo: CalendarInfo,
		colorValue: string,
		existingGroupSettings: GroupSettings | null,
		userSettingsGroupRoot: UserSettingsGroupRoot,
		sharedCalendar: boolean,
	): Children {
		const { group, groupInfo, groupRoot } = calendarInfo
		const user = locator.logins.getUserController().user
		return m(IconButton, {
			title: "more_label",
			colors: ButtonColor.Nav,
			icon: Icons.More,
			size: ButtonSize.Compact,
			click: createDropdown({
				lazyButtons: () => [
					{
						label: "edit_action",
						icon: Icons.Edit,
						size: ButtonSize.Compact,
						click: () => this._onPressedEditCalendar(groupInfo, colorValue, existingGroupSettings, userSettingsGroupRoot, sharedCalendar),
					},
					{
						label: "sharing_label",
						icon: Icons.ContactImport,
						click: () => {
							if (locator.logins.getUserController().isFreeAccount()) {
								showNotAvailableForFreeDialog()
							} else {
								showGroupSharingDialog(groupInfo, sharedCalendar)
							}
						},
					},
					!isApp() && group.type === GroupType.Calendar && hasCapabilityOnGroup(user, group, ShareCapability.Write)
						? {
								label: "import_action",
								icon: Icons.Import,
								click: () => showCalendarImportDialog(groupRoot),
						  }
						: null,
					!isApp() && group.type === GroupType.Calendar && hasCapabilityOnGroup(user, group, ShareCapability.Read)
						? {
								label: "export_action",
								icon: Icons.Export,
								click: () => {
									const alarmInfoList = user.alarmInfoList
									alarmInfoList &&
										exportCalendar(
											getSharedGroupName(groupInfo, locator.logins.getUserController(), sharedCalendar),
											groupRoot,
											alarmInfoList.alarms,
											new Date(),
											getTimeZone(),
										)
								},
						  }
						: null,
					!sharedCalendar
						? {
								label: "delete_action",
								icon: Icons.Trash,
								click: () => this._confirmDeleteCalendar(calendarInfo),
						  }
						: null,
				],
			}),
		})
	}

	_confirmDeleteCalendar(calendarInfo: CalendarInfo) {
		const calendarName = getSharedGroupName(calendarInfo.groupInfo, locator.logins.getUserController(), false)
		loadGroupMembers(calendarInfo.group, locator.entityClient).then((members) => {
			const ownerMail = locator.logins.getUserController().userGroupInfo.mailAddress
			const otherMembers = members.filter((member) => member.info.mailAddress !== ownerMail)
			Dialog.confirm(
				() =>
					(otherMembers.length > 0
						? lang.get("deleteSharedCalendarConfirm_msg", {
								"{calendar}": calendarName,
						  }) + " "
						: "") +
					lang.get("deleteCalendarConfirm_msg", {
						"{calendar}": calendarName,
					}),
			).then((confirmed) => {
				if (confirmed) {
					this.viewModel.deleteCalendar(calendarInfo).catch(ofClass(NotFoundError, () => console.log("Calendar to be deleted was not found.")))
				}
			})
		})
	}

	_onPressedEditCalendar(
		groupInfo: GroupInfo,
		colorValue: string,
		existingGroupSettings: GroupSettings | null,
		userSettingsGroupRoot: UserSettingsGroupRoot,
		shared: boolean,
	) {
		showEditCalendarDialog(
			{
				name: getSharedGroupName(groupInfo, locator.logins.getUserController(), shared),
				color: colorValue.substring(1),
			},
			"edit_action",
			shared,
			(dialog, properties) => {
				if (!shared) {
					groupInfo.name = properties.name
					locator.entityClient.update(groupInfo)
				}

				// color always set for existing calendar
				if (existingGroupSettings) {
					existingGroupSettings.color = properties.color
					existingGroupSettings.name = shared && properties.name !== groupInfo.name ? properties.name : null
				} else {
					const newGroupSettings = createGroupSettings({
						group: groupInfo.group,
						color: properties.color,
						name: shared && properties.name !== groupInfo.name ? properties.name : null,
					})
					userSettingsGroupRoot.groupSettings.push(newGroupSettings)
				}

				locator.entityClient.update(userSettingsGroupRoot)
				dialog.close()
			},
			"save_action",
		)
	}

	view({ attrs }: Vnode<CalendarViewAttrs>): Children {
		return m(
			".main-view",
			m(this.viewSlider, {
				header: m(Header, {
					...attrs.header,
				}),
				bottomNav: m(BottomNav),
			}),
		)
	}

	onNewUrl(args: Record<string, any>) {
		if (!args.view) {
			this._setUrl(this.currentViewType, this.viewModel.selectedDate(), true)
		} else {
			// @ts-ignore
			this.currentViewType = CalendarViewTypeByValue[args.view] ? args.view : CalendarViewType.MONTH
			const urlDateParam = args.date

			if (urlDateParam) {
				// Unlike JS Luxon assumes local time zone when parsing and not UTC. That's what we want
				const luxonDate = DateTime.fromISO(urlDateParam)

				let date = new Date()

				if (luxonDate.isValid) {
					date = luxonDate.toJSDate()
				}

				if (this.viewModel.selectedDate().getTime() !== date.getTime()) {
					this.viewModel.selectedDate(date)

					m.redraw()
				}
			}

			deviceConfig.setDefaultCalendarView(locator.logins.getUserController().user._id, this.currentViewType)
		}
	}

	getViewSlider(): ViewSlider {
		return this.viewSlider
	}

	_setUrl(view: string, date: Date, replace: boolean = false) {
		const dateString = DateTime.fromJSDate(date).toISODate()
		m.route.set(
			"/calendar/:view/:date",
			{
				view,
				date: dateString,
			},
			{
				replace,
			},
		)
	}

	async _onEventSelected(selectedEvent: CalendarEvent, domEvent: MouseOrPointerEvent, htmlSanitizerPromise: Promise<HtmlSanitizer>) {
		const domTarget = domEvent.currentTarget

		if (domTarget == null || !(domTarget instanceof HTMLElement)) {
			return
		}

		const x = domEvent.clientX
		const y = domEvent.clientY

		// We want the popup to show at the users mouse
		const rect = {
			bottom: y,
			height: 0,
			width: 0,
			top: y,
			left: x,
			right: x,
		}

		let calendarInfos

		if (this.viewModel.calendarInfos.isLoaded()) calendarInfos = assertNotNull(this.viewModel.calendarInfos.getSync())
		else calendarInfos = await this.viewModel.calendarInfos.getAsync()

		const [popupModel, htmlSanitizer] = await Promise.all([locator.calendarEventPreviewModel(selectedEvent, calendarInfos), htmlSanitizerPromise])

		new CalendarEventPopup(popupModel, rect, htmlSanitizer).show()
	}

	private showCalendarPopup(dom: HTMLElement) {
		// When the user clicks the month name in the header, the target can be the month's name or the icon on the right
		// side of month's name, so we hardcoded the left spacing to be the same used by the month name, so doesn't matter
		// if the user clicks on month's name or on the icon
		const elementRect = { ...dom.getBoundingClientRect(), left: size.button_height }

		const selector = new DaySelectorPopup(elementRect, {
			selectedDate: getStartOfDay(this.viewModel.selectedDate()),
			onDateSelected: (date: Date) => {
				this.viewModel.selectedDate(date)
				this._setUrl(this.currentViewType, date)
				selector.close()
			},
			startOfTheWeekOffset: getStartOfTheWeekOffset(locator.logins.getUserController().userSettingsGroupRoot.startOfTheWeek as WeekStart),
			eventsForDays: this.viewModel.eventsForDays,
			highlightToday: true,
			highlightSelectedWeek: this.currentViewType === CalendarViewType.WEEK,
		})

		selector.show()
	}
}
