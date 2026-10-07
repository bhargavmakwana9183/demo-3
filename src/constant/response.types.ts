export enum RES_TYPES {
    CREATE = 'Data Insert Successfully',
    UPDATE = 'Data Update Successfully',
    DELETE = 'Data deleted Successfully',
    FETCH = 'Data Fetch Successfully',
    ID_NOT_FOUND = 'Id not found/Match',
    SELECT_NOT_FOUND = 'Select not found/Match',
    LOGIN = 'Congrats! You have Successfully logged in',
    AUTH_FAIL = 'Authentication failed. Wrong Password or email',
    LOGOUT = 'User Logged out Successfully',
    VALID_DATE = 'Please Select Valid date',
    NOT_APPLY = 'You Can Not Apply Leave at HoliDay',
    NOT_DELETE = 'This Leave is Approved you can not delete it.',
    NOT_PERMISSION = 'You do not have permission to access this route.',
    NO_FOUND = 'This Data not found',
    ALREADY_LOGOUT = 'User Have Already Logout',
    LOGOUT_FAIL = 'logout Failed',
    UNIQUE = 'This data is already stored Please give unique Email or userName',
    BAD_URL = 'Bad Request URL not Found',
    UNIQUE_DATE = 'You already assign for different task at this time',
    SOMETHING_WRONG = 'Something went wrong !!! You try to insert single in bulk.',
    ACTIVE_YOUR_ACCOUNT = 'First You have to active your account after you can access this route',
    INTIALROUTES_SUBCLASSES = 'Subclasses must implement initializeRoutes method.',
    USER_NOT_FOUND = 'User not found',
    OTP = 'Sucessfully Send OTP',
    NOT_VALIDATE_OTP = 'Invalid OTP Please Check',
    VALIDATE_OTP = 'sucessfully verify OTP',
    INVALID_DATE = 'End date must be greater than or equal to start date',
    DUPLICATEUSER = 'User Already Exists',
    INVALID_TIME = 'Clock-out time must be greater than clock-in time.',
    FILE_NOTFOUND = 'File not found pls insert file',
    NOT_UPLOAD = 'Error In Uploading',
    NO_MSG = '',
    UPLOADED = 'Successfully Uploaded',
    BACKUP = ' Error In Backup File ',
    NOT_FOUND_IMAGE = 'Please provide image',
    VALUE_NULL = 'Please provide profile completed by field ',
    NOT_VALID_ROLE = 'please provide valid role',
    INVALID_NOTIFICATION_TYPE = 'Please provide valid notification type',
    WRONG_PASSWORD = 'Please correct old password',
}

export enum RES_STATUS {
    CREATE = 'CREATE',
    DELETE = 'DELETE',
    UPDATE = 'UPDATE',
    GET = 'GET',
}

export enum ROLES {
    CHILD = '0',
    SUPER_ADMIN = '1',
    PARENT = '2',
    UNIVERSITY = '3',
    PROFESSIONAL = '4',
}

export enum MODEL {
    USER = 'userModel',
    INSTRUMENT = 'instrumentsModel',
    CANDELS = 'candelsModel',
    OPTIONS_CHAINS = 'OptionchainModel',
    HEDGING_TIME = 'hedgingTimeModel',
    HEDGING_OPTIONS = 'hedgingOptionsModel',
    STRIKE_MODEL = 'strikePriceModel',
    STRATEGY = 'strategyModel',
    POSITION = 'positionModel',
    TRADE = 'tradeModel',
    UPSTOCK_ORDERS = 'UpstocksOrderModel',
    TRADE_UPDATE = 'tradeUpdateModel',
    TRADE_LEG_HISTORY = 'tradeLegHistoryModel',
    STRATEGY_CONFIG = 'strategyConfigModel',
    STRATEGY_DAILY_STATS = 'strategyDailyStatsModel',
    DECISION_AUDIT = 'decisionAuditModel',
}

export enum INDEXES {
    MIDCAP = 'NSE_INDEX|NIFTY MID SELECT',
    NIFTY_50 = 'NSE_INDEX|Nifty 50',
    BANKNIFTY = 'NSE_INDEX|Nifty Bank',
    FINNITY = 'NSE_INDEX|Nifty Fin Service',
}
export enum INDEXES_NAMES {
    MIDCAP = 'MIDCPNIFTY',
    NIFTY_50 = 'NIFTY',
    BANKNIFTY = 'BANKNIFTY',
    FINNITY = 'FINNIFTY',
}

export enum USER_DETAILS {
    EMAIL = 'bhargav9183@gmail.com',
}

export enum STRATEGY {
    PERCENTAGE = 'PERCENTAGE',
    PERCENTAGE_WITHOUT_CONDITIONS = 'PERCENTAGE_WITHOUT_CONDITIONS',
    SBIN_TIMING = 'SBIN_TIMING',
    SCALLPING = 'SCALLPING',
    SCALLPING_TRAILLING = 'SCALLPING_TRAILLING',
    NIFTY_OPTIONS_SCALP = 'NIFTY_OPTIONS_SCALP',
}
export enum INSTRUMENT_KEYS {
    SBIN_INSTRUMENT = 'NSE_EQ|INE062A01020',
}
