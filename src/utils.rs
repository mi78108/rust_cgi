use std::collections::HashMap;

pub trait JsonStr {
    fn stringify(&self) -> String;
}

impl<T> JsonStr for Vec<T> where T: JsonStr{
    fn stringify(&self) -> String {
        format!("[{}]",self.iter().map(|v|{
            v.stringify()
        }).collect::<Vec<String>>().join(","))
    }
}

impl<K,V> JsonStr for HashMap<K,V> where K: JsonStr, V:JsonStr{
    fn stringify(&self) -> String {
        format!("{{{}}}", self.iter().map(|(k,v)|{
            format!("{}:{}",k.stringify(),v.stringify())
        }).collect::<Vec<String>>().join(","))
    }
}

impl JsonStr for bool {
    fn stringify(&self) -> String {
        format!("{}", self)
    }
}
impl JsonStr for &str {
    fn stringify(&self) -> String {
        format!("\"{}\"", self)
    }
}
impl JsonStr for String {
    fn stringify(&self) -> String {
        format!("\"{}\"", self)
    }
}
impl JsonStr for usize {
    fn stringify(&self) -> String {
        format!("{}", self)
    }
}
impl JsonStr for isize {
    fn stringify(&self) -> String {
        format!("{}", self)
    }
}
impl JsonStr for u8 {
    fn stringify(&self) -> String {
        format!("{}", self)
    }
}
impl JsonStr for i32 {
    fn stringify(&self) -> String {
        format!("{}", self)
    }
}

#[test]
fn utils_test(){
    let mut vv:HashMap<String, HashMap<String,String>> = HashMap::new();
    let mut v:HashMap<String, String> = HashMap::new();
    v.insert("ab".into(), "cd".into());
    vv.insert("a".into(), v);
    println!("{}",vec![1,2,3,4].stringify());
}
