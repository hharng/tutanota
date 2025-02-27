import type { InvoiceData, PaymentData, SpamRuleFieldType, SpamRuleType } from "../../../common/TutanotaConstants.js"
import { AccountType, BookingItemFeatureType, Const, CounterType, CryptoProtocolVersion, GroupType } from "../../../common/TutanotaConstants.js"
import type {
	AccountingInfo,
	CustomDomainReturn,
	CustomerServerProperties,
	EmailSenderListElement,
	PaymentDataServicePutReturn,
} from "../../../entities/sys/TypeRefs.js"
import {
	AccountingInfoTypeRef,
	createBrandingDomainData,
	createBrandingDomainDeleteData,
	createCreateCustomerServerPropertiesData,
	createCustomDomainData,
	createEmailSenderListElement,
	createMembershipAddData,
	createMembershipRemoveData,
	createPaymentDataServicePutData,
	createPdfInvoiceServiceData,
	CustomerInfoTypeRef,
	CustomerServerPropertiesTypeRef,
	CustomerTypeRef,
} from "../../../entities/sys/TypeRefs.js"
import { assertWorkerOrNode } from "../../../common/Env.js"
import type { Hex } from "@tutao/tutanota-utils"
import { assertNotNull, neverNull, noOp, ofClass, stringToUtf8Uint8Array, uint8ArrayToBase64, uint8ArrayToHex } from "@tutao/tutanota-utils"
import { getWhitelabelDomain } from "../../../common/utils/Utils.js"
import { CryptoFacade } from "../../crypto/CryptoFacade.js"
import {
	BrandingDomainService,
	CreateCustomerServerProperties,
	CustomDomainService,
	MembershipService,
	PaymentDataService,
	PdfInvoiceService,
	SystemKeysService,
} from "../../../entities/sys/Services.js"
import { createCustomerAccountCreateData } from "../../../entities/tutanota/TypeRefs.js"
import type { UserManagementFacade } from "./UserManagementFacade.js"
import type { GroupManagementFacade } from "./GroupManagementFacade.js"
import { CounterFacade } from "./CounterFacade.js"
import type { Country } from "../../../common/CountryList.js"
import { getByAbbreviation } from "../../../common/CountryList.js"
import { LockedError } from "../../../common/error/RestError.js"
import type { RsaKeyPair } from "@tutao/tutanota-crypto"
import { aes256RandomKey, bitArrayToUint8Array, encryptKey, hexToRsaPublicKey, sha256Hash, uint8ArrayToBitArray } from "@tutao/tutanota-crypto"
import type { RsaImplementation } from "../../crypto/RsaImplementation.js"
import { EntityClient } from "../../../common/EntityClient.js"
import { DataFile } from "../../../common/DataFile.js"
import { IServiceExecutor } from "../../../common/ServiceRequest.js"
import { CustomerAccountService } from "../../../entities/tutanota/Services.js"
import { BookingFacade } from "./BookingFacade.js"
import { UserFacade } from "../UserFacade.js"
import { PaymentInterval } from "../../../../subscription/PriceUtils.js"
import { ExposedOperationProgressTracker, OperationId } from "../../../main/OperationProgressTracker.js"
import { formatNameAndAddress } from "../../../common/utils/CommonFormatter.js"
import { PQFacade } from "../PQFacade.js"
import { ProgrammingError } from "../../../common/error/ProgrammingError.js"

assertWorkerOrNode()

export class CustomerFacade {
	constructor(
		private readonly userFacade: UserFacade,
		private readonly groupManagement: GroupManagementFacade,
		private readonly userManagement: UserManagementFacade,
		private readonly counters: CounterFacade,
		private readonly rsa: RsaImplementation,
		private readonly entityClient: EntityClient,
		private readonly serviceExecutor: IServiceExecutor,
		private readonly bookingFacade: BookingFacade,
		private readonly cryptoFacade: CryptoFacade,
		private readonly operationProgressTracker: ExposedOperationProgressTracker,
		private readonly pq: PQFacade,
	) {}

	async getDomainValidationRecord(domainName: string): Promise<string> {
		const customer = this.getCustomerId()
		const baseString = domainName.trim().toLowerCase() + customer
		const hash = sha256Hash(stringToUtf8Uint8Array(baseString)).slice(0, 16)
		return "t-verify=" + uint8ArrayToHex(hash)
	}

	addDomain(domainName: string): Promise<CustomDomainReturn> {
		const data = createCustomDomainData({
			domain: domainName.trim().toLowerCase(),
			catchAllMailGroup: null,
		})
		return this.serviceExecutor.post(CustomDomainService, data)
	}

	async removeDomain(domainName: string): Promise<void> {
		const data = createCustomDomainData({
			domain: domainName.trim().toLowerCase(),
			catchAllMailGroup: null,
		})
		await this.serviceExecutor.delete(CustomDomainService, data)
	}

	async setCatchAllGroup(domainName: string, mailGroupId: Id | null): Promise<void> {
		const data = createCustomDomainData({
			domain: domainName.trim().toLowerCase(),
			catchAllMailGroup: mailGroupId,
		})
		await this.serviceExecutor.put(CustomDomainService, data)
	}

	async orderWhitelabelCertificate(domainName: string): Promise<void> {
		const customerId = this.getCustomerId()
		const customer = await this.entityClient.load(CustomerTypeRef, customerId)
		const customerInfo = await this.entityClient.load(CustomerInfoTypeRef, customer.customerInfo)
		let existingBrandingDomain = getWhitelabelDomain(customerInfo, domainName)
		let sessionKey = aes256RandomKey()

		const keyData = await this.serviceExecutor.get(SystemKeysService, null)
		const pubRsaKey = keyData.systemAdminPubRsaKey
		const pubEccKey = keyData.systemAdminPubEccKey
		const pubKyberKey = keyData.systemAdminPubKyberKey
		const systemAdminPubKeys = { pubEccKey, pubKyberKey, pubRsaKey }
		const { pubEncSymKey, cryptoProtocolVersion } = await this.cryptoFacade.encryptPubSymKey(
			sessionKey,
			systemAdminPubKeys,
			this.userFacade.getUserGroupId(),
		)

		const data = createBrandingDomainData({
			domain: domainName,
			systemAdminPubEncSessionKey: pubEncSymKey,
			systemAdminPublicProtocolVersion: cryptoProtocolVersion,
			sessionEncPemPrivateKey: null,
			sessionEncPemCertificateChain: null,
		})
		if (existingBrandingDomain) {
			await this.serviceExecutor.put(BrandingDomainService, data)
		} else {
			await this.serviceExecutor.post(BrandingDomainService, data)
		}
	}

	private getCustomerId() {
		return assertNotNull(this.userFacade.getLoggedInUser().customer)
	}

	async deleteCertificate(domainName: string): Promise<void> {
		const data = createBrandingDomainDeleteData({
			domain: domainName,
		})
		await this.serviceExecutor.delete(BrandingDomainService, data)
	}

	/**
	 * Reads the used storage of a customer in bytes.
	 * @return The amount of used storage in byte.
	 */
	async readUsedCustomerStorage(customerId: Id): Promise<number> {
		const customerCounters = await this.counters.readAllCustomerCounterValues(CounterType.UserStorageLegacy, customerId)
		return customerCounters.reduce((sum, counterValue) => sum + Number(counterValue.value), 0)
	}

	/**
	 * Reads the available storage capacity of a customer in bytes.
	 * @return The amount of available storage capacity in byte.
	 */
	readAvailableCustomerStorage(customerId: Id): Promise<number> {
		return this.entityClient.load(CustomerTypeRef, customerId).then((customer) => {
			return this.entityClient.load(CustomerInfoTypeRef, customer.customerInfo).then((customerInfo) => {
				let includedStorage = Number(customerInfo.includedStorageCapacity)
				let promotionStorage = Number(customerInfo.promotionStorageCapacity)
				let availableStorage = Math.max(includedStorage, promotionStorage)
				let bookedStorage = 0

				if (customer.type === AccountType.PAID) {
					return this.bookingFacade.getCurrentPrice().then((price) => {
						let currentStorageItem = this.bookingFacade.getPriceItem(price.currentPriceNextPeriod, BookingItemFeatureType.Storage)

						if (currentStorageItem != null) {
							bookedStorage = Number(currentStorageItem.count)
						}

						availableStorage = Math.max(bookedStorage, availableStorage)
						return availableStorage * Const.MEMORY_GB_FACTOR
					})
				} else {
					return availableStorage * Const.MEMORY_GB_FACTOR
				}
			})
		})
	}

	async loadCustomerServerProperties(): Promise<CustomerServerProperties> {
		const customer = await this.entityClient.load(CustomerTypeRef, this.getCustomerId())
		let cspId
		if (customer.serverProperties) {
			cspId = customer.serverProperties
		} else {
			// create properties
			const sessionKey = aes256RandomKey()
			const adminGroupKey = this.userFacade.getGroupKey(this.userFacade.getGroupId(GroupType.Admin))

			const groupEncSessionKey = encryptKey(adminGroupKey, sessionKey)
			const data = createCreateCustomerServerPropertiesData({
				adminGroupEncSessionKey: groupEncSessionKey,
			})
			const returnData = await this.serviceExecutor.post(CreateCustomerServerProperties, data)
			cspId = returnData.id
		}
		return this.entityClient.load(CustomerServerPropertiesTypeRef, cspId)
	}

	addSpamRule(field: SpamRuleFieldType, type: SpamRuleType, value: string): Promise<void> {
		return this.loadCustomerServerProperties().then((props) => {
			value = value.toLowerCase().trim()
			let newListEntry = createEmailSenderListElement({
				value,
				hashedValue: uint8ArrayToBase64(sha256Hash(stringToUtf8Uint8Array(value))),
				type,
				field,
			})
			props.emailSenderList.push(newListEntry)
			return this.entityClient.update(props).catch(ofClass(LockedError, noOp))
		})
	}

	editSpamRule(spamRule: EmailSenderListElement): Promise<void> {
		return this.loadCustomerServerProperties().then((props) => {
			spamRule.value = spamRule.value.toLowerCase().trim()
			const index = props.emailSenderList.findIndex((item) => spamRule._id === item._id)

			if (index === -1) {
				throw new Error("spam rule does not exist " + JSON.stringify(spamRule))
			}

			props.emailSenderList[index] = spamRule
			return this.entityClient.update(props).catch(ofClass(LockedError, noOp))
		})
	}

	async generateSignupKeys(operationId: OperationId): Promise<[RsaKeyPair, RsaKeyPair, RsaKeyPair]> {
		const key1 = await this.rsa.generateKey()
		await this.operationProgressTracker.onProgress(operationId, 33)
		const key2 = await this.rsa.generateKey()
		await this.operationProgressTracker.onProgress(operationId, 66)
		const key3 = await this.rsa.generateKey()
		await this.operationProgressTracker.onProgress(operationId, 100)
		return [key1, key2, key3]
	}

	async signup(
		keyPairs: [RsaKeyPair, RsaKeyPair, RsaKeyPair],
		accountType: AccountType,
		authToken: string,
		mailAddress: string,
		password: string,
		registrationCode: string,
		currentLanguage: string,
	): Promise<Hex> {
		const userGroupKey = aes256RandomKey()
		const adminGroupKey = aes256RandomKey()
		const customerGroupKey = aes256RandomKey()
		const userGroupInfoSessionKey = aes256RandomKey()
		const adminGroupInfoSessionKey = aes256RandomKey()
		const customerGroupInfoSessionKey = aes256RandomKey()
		const accountingInfoSessionKey = aes256RandomKey()
		const customerServerPropertiesSessionKey = aes256RandomKey()

		const keyData = await this.serviceExecutor.get(SystemKeysService, null)
		const pubRsaKey = keyData.systemAdminPubRsaKey
		const pubEccKey = keyData.systemAdminPubEccKey
		const pubKyberKey = keyData.systemAdminPubKyberKey
		let systemAdminPubEncAccountingInfoSessionKey
		let systemAdminPublicProtocolVersion

		if (pubRsaKey) {
			const rsaPublicKey = hexToRsaPublicKey(uint8ArrayToHex(pubRsaKey))
			systemAdminPubEncAccountingInfoSessionKey = await this.rsa.encrypt(rsaPublicKey, bitArrayToUint8Array(accountingInfoSessionKey))
			systemAdminPublicProtocolVersion = CryptoProtocolVersion.RSA
		} else {
			// we need to release tuta-crypt by default first before we can encrypt keys for the system admin with PQ public keys.
			throw new ProgrammingError("system admin having pq key pair is not supported")
		}

		const userGroupData = this.groupManagement.generateInternalGroupData(
			keyPairs[0],
			userGroupKey,
			userGroupInfoSessionKey,
			null,
			adminGroupKey,
			customerGroupKey,
		)

		const adminGroupData = this.groupManagement.generateInternalGroupData(
			keyPairs[1],
			adminGroupKey,
			adminGroupInfoSessionKey,
			null,
			adminGroupKey,
			customerGroupKey,
		)

		const customerGroupData = this.groupManagement.generateInternalGroupData(
			keyPairs[2],
			customerGroupKey,
			customerGroupInfoSessionKey,
			null,
			adminGroupKey,
			customerGroupKey,
		)

		const recoverData = this.userManagement.generateRecoveryCode(userGroupKey)

		const data = createCustomerAccountCreateData({
			authToken,
			date: Const.CURRENT_DATE,
			lang: currentLanguage,
			code: registrationCode,
			userData: await this.userManagement.generateUserAccountData(
				userGroupKey,
				userGroupInfoSessionKey,
				customerGroupKey,
				mailAddress,
				password,
				"",
				recoverData,
			),
			userEncAdminGroupKey: encryptKey(userGroupKey, adminGroupKey),
			userGroupData,
			adminGroupData,
			customerGroupData,
			adminEncAccountingInfoSessionKey: encryptKey(adminGroupKey, accountingInfoSessionKey),
			systemAdminPubEncAccountingInfoSessionKey,
			systemAdminPublicProtocolVersion,
			adminEncCustomerServerPropertiesSessionKey: encryptKey(adminGroupKey, customerServerPropertiesSessionKey),
			userEncAccountGroupKey: new Uint8Array(0),
		})
		await this.serviceExecutor.post(CustomerAccountService, data)
		return recoverData.hexCode
	}

	async switchFreeToPremiumGroup(): Promise<void> {
		try {
			const keyData = await this.serviceExecutor.get(SystemKeysService, null)
			const membershipAddData = createMembershipAddData({
				user: this.userFacade.getLoggedInUser()._id,
				group: neverNull(keyData.premiumGroup),
				symEncGKey: encryptKey(this.userFacade.getUserGroupKey(), uint8ArrayToBitArray(keyData.premiumGroupKey)),
			})
			await this.serviceExecutor.post(MembershipService, membershipAddData)
			const membershipRemoveData = createMembershipRemoveData({
				user: this.userFacade.getLoggedInUser()._id,
				group: neverNull(keyData.freeGroup),
			})
			await this.serviceExecutor.delete(MembershipService, membershipRemoveData)
		} catch (e) {
			e.message = e.message + " error switching free to premium group"
			console.log(e)
			throw e
		}
	}

	async switchPremiumToFreeGroup(): Promise<void> {
		try {
			const keyData = await this.serviceExecutor.get(SystemKeysService, null)
			const membershipAddData = createMembershipAddData({
				user: this.userFacade.getLoggedInUser()._id,
				group: neverNull(keyData.freeGroup),
				symEncGKey: encryptKey(this.userFacade.getUserGroupKey(), uint8ArrayToBitArray(keyData.freeGroupKey)),
			})
			await this.serviceExecutor.post(MembershipService, membershipAddData)
			const membershipRemoveData = createMembershipRemoveData({
				user: this.userFacade.getLoggedInUser()._id,
				group: neverNull(keyData.premiumGroup),
			})
			await this.serviceExecutor.delete(MembershipService, membershipRemoveData)
		} catch (e) {
			e.message = e.message + " error switching premium to free group"
			console.log(e)
			throw e
		}
	}

	async updatePaymentData(
		paymentInterval: PaymentInterval,
		invoiceData: InvoiceData,
		paymentData: PaymentData | null,
		confirmedInvoiceCountry: Country | null,
	): Promise<PaymentDataServicePutReturn> {
		let customer = await this.entityClient.load(CustomerTypeRef, assertNotNull(this.userFacade.getLoggedInUser().customer))
		let customerInfo = await this.entityClient.load(CustomerInfoTypeRef, customer.customerInfo)
		let accountingInfo = await this.entityClient.load(AccountingInfoTypeRef, customerInfo.accountingInfo)
		let accountingInfoSessionKey = await this.cryptoFacade.resolveSessionKeyForInstance(accountingInfo)
		const service = createPaymentDataServicePutData({
			paymentInterval: paymentInterval.toString(),
			invoiceName: "",
			invoiceAddress: invoiceData.invoiceAddress,
			invoiceCountry: invoiceData.country ? invoiceData.country.a : "",
			invoiceVatIdNo: invoiceData.vatNumber ? invoiceData.vatNumber : "",
			paymentMethod: paymentData ? paymentData.paymentMethod : accountingInfo.paymentMethod ? accountingInfo.paymentMethod : "",
			paymentMethodInfo: null,
			paymentToken: null,
			creditCard: paymentData && paymentData.creditCardData ? paymentData.creditCardData : null,
			confirmedCountry: confirmedInvoiceCountry ? confirmedInvoiceCountry.a : null,
		})
		return this.serviceExecutor.put(PaymentDataService, service, { sessionKey: accountingInfoSessionKey ?? undefined })
	}

	/**
	 * Convenience function to change the payment interval for the current subscription
	 * @param accountingInfo accounting info
	 * @param newPaymentInterval new payment interval
	 */
	async changePaymentInterval(accountingInfo: AccountingInfo, newPaymentInterval: PaymentInterval): Promise<PaymentDataServicePutReturn> {
		const invoiceCountry = neverNull(getByAbbreviation(neverNull(accountingInfo.invoiceCountry)))

		return this.updatePaymentData(
			newPaymentInterval,
			{
				invoiceAddress: formatNameAndAddress(accountingInfo.invoiceName, accountingInfo.invoiceAddress),
				country: invoiceCountry,
				vatNumber: accountingInfo.invoiceVatIdNo,
			},
			null,
			invoiceCountry,
		)
	}

	async downloadInvoice(invoiceNumber: string): Promise<DataFile> {
		const data = createPdfInvoiceServiceData({
			invoiceNumber,
			invoice: null,
		})
		return this.serviceExecutor.get(PdfInvoiceService, data).then((returnData) => {
			return {
				_type: "DataFile",
				name: String(invoiceNumber) + ".pdf",
				mimeType: "application/pdf",
				data: returnData.data,
				size: returnData.data.byteLength,
				id: undefined,
			}
		})
	}

	async loadAccountingInfo(): Promise<AccountingInfo> {
		const customer = await this.entityClient.load(CustomerTypeRef, assertNotNull(this.userFacade.getUser()?.customer))
		const customerInfo = await this.entityClient.load(CustomerInfoTypeRef, customer.customerInfo)
		return this.entityClient.load(AccountingInfoTypeRef, customerInfo.accountingInfo)
	}
}
